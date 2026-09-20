import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ProjectScanResult } from './projectScanner.js'
import { angleFromPolicyAzimuth, directionForAngle, loadChairDecisionPolicy } from './chairAnglePolicy.js'
import type { SemanticAngle } from './chairAnglePolicy.js'
import { runProcess } from './codexRuntime.js'

type Observability = 'exact' | 'coarse' | 'none'
type CoarseDirection = 'front' | 'right' | 'back' | 'left' | 'unknown'
type ReviewState = 'confirmed' | 'corrected'
type PublishTarget = 'skill' | 'database'

interface FootrestInput {
  capability: 'present' | 'absent' | 'unknown'
  state: 'retracted' | 'partial' | 'extended' | 'not_applicable' | 'unknown'
  visibility?: number
  confidence?: number
  decisiveCue?: string
}

interface InstanceInput {
  id: string
  azimuth: number
  confidence?: number
  decisiveCue?: string
  reclineState?: 'upright' | 'reclined' | 'unknown'
  footrest?: FootrestInput
}

export interface SkillTrainingReviewInput {
  scenePath: string
  reviewState: ReviewState
  angleObservability?: Observability
  coarseDirection?: CoarseDirection
  azimuth?: number | null
  sceneMode?: 'single' | 'multi_same_model' | 'multi_mixed'
  footrest?: FootrestInput
  instances?: InstanceInput[]
  reviewerNote?: string
}

export interface ReferenceTrainingInput {
  scenePath: string
  selectedProductPaths: string[]
  suggestedProductPaths?: string[]
}

interface ReviewEntry {
  scenePath: string
  reviewState: ReviewState
  reviewerNote: string
  original: any
  adjusted: any
}

interface ReviewArtifact {
  version: 1
  reviewId: string
  createdAt: string
  projectRoot: string
  policyId: string
  skillId: string
  entries: ReviewEntry[]
}

interface InlineOverrideArtifact {
  version: 1
  updatedAt: string
  results: Record<string, { imageSha256: string; adjusted: any }>
}

interface InlineTrainingOptions {
  signal?: AbortSignal
  skillCorpusPath?: string
}

const OBSERVABILITY = new Set<Observability>(['exact', 'coarse', 'none'])
const COARSE_DIRECTIONS = new Set<CoarseDirection>(['front', 'right', 'back', 'left', 'unknown'])
const PARTS = ['backrest', 'seat', 'leftArmrest', 'rightArmrest', 'base', 'footrestPad', 'rails'] as const
const corpusWriteQueues = new Map<string, Promise<unknown>>()

function projectRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function clamp(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback
}

function normalizeAzimuth(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? ((parsed % 360) + 360) % 360 : null
}

function normalizeFootrest(value: FootrestInput | undefined, fallback: any): any {
  const source = value ?? fallback ?? {}
  const capability = ['present', 'absent', 'unknown'].includes(source.capability) ? source.capability : 'unknown'
  let state = ['retracted', 'partial', 'extended', 'not_applicable', 'unknown'].includes(source.state)
    ? source.state
    : 'unknown'
  if (capability === 'absent') state = 'not_applicable'
  if (capability !== 'absent' && state === 'not_applicable') state = 'unknown'
  return {
    capability,
    state,
    visibility: clamp(source.visibility, 0),
    confidence: clamp(source.confidence, 0),
    decisiveCue: String(source.decisiveCue ?? '人工复核后未补充脚垫依据。').slice(0, 1000),
  }
}

function defaultCoarseDirection(angle: string): CoarseDirection {
  if (['front', 'front_right', 'front_left'].includes(angle)) return 'front'
  if (['right', 'back_right'].includes(angle)) return 'right'
  if (['left', 'back_left'].includes(angle)) return 'left'
  return angle === 'back' ? 'back' : 'unknown'
}

function resolveInside(root: string, value: string): string {
  const absolute = resolve(root, value)
  const rel = relative(root, absolute)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`训练成果路径越界：${value}`)
  return absolute
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, path)
}

async function currentSceneArtifactPath(trainingDir: string): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(join(trainingDir, 'current-run.json'), 'utf8'))
    if (manifest.version !== 1 || typeof manifest.sceneResultsPath !== 'string') throw new Error('当前训练运行清单无效')
    return resolveInside(trainingDir, manifest.sceneResultsPath)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return join(trainingDir, 'scene-angle-results.json')
    throw error
  }
}

async function productIndexArtifactPath(trainingDir: string, skillRoot: string): Promise<string> {
  for (const candidate of [
    join(trainingDir, 'product-angle-index.json'),
    join(skillRoot, 'references', 'product-angle-index.json'),
  ]) {
    try {
      await access(candidate)
      return candidate
    } catch {}
  }
  throw new Error('训练 Skill 缺少 product-angle-index.json')
}

function adjustObservation(original: any, input: SkillTrainingReviewInput, policy: Awaited<ReturnType<typeof loadChairDecisionPolicy>>): any {
  if (input.reviewState === 'confirmed') return { ...original }
  const angleObservability = OBSERVABILITY.has(input.angleObservability as Observability)
    ? input.angleObservability as Observability
    : 'none'
  const sceneMode = ['single', 'multi_same_model', 'multi_mixed'].includes(input.sceneMode ?? '')
    ? input.sceneMode
    : original.sceneMode ?? 'single'
  const requestedAzimuth = normalizeAzimuth(input.azimuth)
  let angle: SemanticAngle | 'multiple' | 'unknown' = 'unknown'
  let azimuth: number | null = null
  let imageFacingDirection = 'unknown'
  if (angleObservability === 'exact' && sceneMode === 'single' && requestedAzimuth !== null) {
    angle = angleFromPolicyAzimuth(requestedAzimuth, policy)
    azimuth = requestedAzimuth
    imageFacingDirection = directionForAngle(angle, policy)
  } else if (angleObservability === 'exact' && sceneMode !== 'single') {
    angle = 'multiple'
    imageFacingDirection = 'multiple'
  }
  const coarseDirection = COARSE_DIRECTIONS.has(input.coarseDirection as CoarseDirection)
    ? input.coarseDirection as CoarseDirection
    : defaultCoarseDirection(angle)
  if (angleObservability === 'coarse') {
    imageFacingDirection = coarseDirection === 'left' || coarseDirection === 'right' ? coarseDirection : 'center'
  }
  const footrest = { ...normalizeFootrest(input.footrest, original.footrest), confidence: 1 }
  const instances = sceneMode === 'multi_same_model' && angleObservability === 'exact'
    ? (input.instances ?? original.instances ?? []).flatMap((instance: InstanceInput) => {
        const instanceAzimuth = normalizeAzimuth(instance.azimuth)
        if (instanceAzimuth === null) return []
        const instanceAngle = angleFromPolicyAzimuth(instanceAzimuth, policy)
        return [{
          id: String(instance.id),
          angle: instanceAngle,
          azimuth: instanceAzimuth,
          imageFacingDirection: directionForAngle(instanceAngle, policy),
          confidence: 1,
          decisiveCue: String(instance.decisiveCue ?? '人工调整多椅实例角度。').slice(0, 1000),
          reclineState: ['upright', 'reclined'].includes(instance.reclineState ?? '') ? instance.reclineState : 'unknown',
          footrest: { ...normalizeFootrest(instance.footrest, footrest), confidence: 1 },
        }]
      })
    : []
  const matchable = angleObservability === 'exact'
    && ((sceneMode === 'single' && azimuth !== null)
      || (sceneMode === 'multi_same_model' && instances.length >= policy.multiView.minInstances))
  const confidence = 1
  const occlusion = clamp(original.occlusion, 1)
  const status = !matchable
    ? 'unmatched'
    : sceneMode === 'multi_same_model'
      ? policy.multiView.status
      : confidence >= policy.autoThresholds.minAngleConfidence && occlusion <= policy.autoThresholds.maxOcclusion
        ? 'auto'
        : 'review'
  return {
    ...original,
    angle,
    azimuth,
    imageFacingDirection: angleObservability === 'none' ? 'unknown' : imageFacingDirection,
    angleObservability,
    coarseDirection: angleObservability === 'none' ? 'unknown' : coarseDirection,
    sceneMode,
    confidence,
    occlusion,
    chairCount: sceneMode === 'single' ? 1 : instances.length || Number(original.chairCount) || 0,
    sameModelConfidence: sceneMode === 'multi_same_model' ? 1 : original.sameModelConfidence ?? null,
    matchable,
    status,
    decisiveCue: `人工调整：${String(input.reviewerNote || '已复核角度与脚垫标签。').slice(0, 500)}`,
    instances,
    footrest,
    humanReview: {
      state: input.reviewState,
      reviewedAt: new Date().toISOString(),
      modelConfidence: clamp(original.confidence, 0),
    },
  }
}

export async function recalculateSkillTrainingReview(
  project: ProjectScanResult,
  reviews: SkillTrainingReviewInput[],
  skillId = 'chair-angle-matcher',
  signal?: AbortSignal,
): Promise<{ reviewId: string; reviewCount: number; correctedCount: number }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(skillId)) throw new Error('训练 Skill 标识无效')
  const trainingDir = join(project.root, '.scenecolor', 'skill-training')
  const sourcePath = await currentSceneArtifactPath(trainingDir)
  const sourceArtifact = JSON.parse(await readFile(sourcePath, 'utf8'))
  if (!Array.isArray(sourceArtifact.results)) throw new Error('当前识别结果缺少 results')
  const relativeScenes = new Set(project.scenes.map(path => projectRelative(project.root, path)))
  const reviewByPath = new Map<string, SkillTrainingReviewInput>()
  for (const review of reviews) {
    const absoluteScene = resolve(review.scenePath)
    if (!project.scenes.includes(absoluteScene)) throw new Error(`复核场景不属于当前项目：${review.scenePath}`)
    const relativeScene = projectRelative(project.root, absoluteScene)
    if (reviewByPath.has(relativeScene)) throw new Error(`场景重复提交复核：${relativeScene}`)
    if (!['confirmed', 'corrected'].includes(review.reviewState)) throw new Error(`场景缺少人工复核状态：${relativeScene}`)
    reviewByPath.set(relativeScene, review)
  }
  if (reviewByPath.size !== relativeScenes.size || [...relativeScenes].some(path => !reviewByPath.has(path))) {
    throw new Error('必须逐图核对全部场景后才能重新计算')
  }
  const sourceByPath = new Map(sourceArtifact.results.map((item: any) => [item.scenePath, item]))
  if ([...relativeScenes].some(path => !sourceByPath.has(path))) throw new Error('当前识别结果与项目场景不完整')
  const appRoot = resolve(process.cwd())
  const skillRoot = join(appRoot, 'skills', skillId)
  const policyPath = join(skillRoot, 'references', 'decision-policy.json')
  const policy = await loadChairDecisionPolicy(policyPath)
  const entries = [...relativeScenes].map(scenePath => {
    const input = reviewByPath.get(scenePath)!
    const original = sourceByPath.get(scenePath)
    return {
      scenePath,
      reviewState: input.reviewState,
      reviewerNote: String(input.reviewerNote ?? '').slice(0, 1000),
      original,
      adjusted: adjustObservation(original, input, policy),
    } satisfies ReviewEntry
  })
  const reviewId = randomUUID()
  const runDir = join(trainingDir, 'runs', `review-${reviewId}`)
  const sceneResultsPath = join(runDir, 'scene-angle-results.json')
  const matchResultsPath = join(runDir, 'footrest-matching-results.json')
  const reviewPath = join(trainingDir, 'reviews', `${reviewId}.json`)
  const productIndexPath = await (async () => {
    for (const candidate of [join(trainingDir, 'product-angle-index.json'), join(skillRoot, 'references', 'product-angle-index.json')]) {
      try { await access(candidate); return candidate } catch {}
    }
    throw new Error('训练 Skill 缺少 product-angle-index.json')
  })()
  const artifact = {
    version: 9,
    source: 'human-reviewed chair observations',
    createdAt: new Date().toISOString(),
    policyId: policy.policyId,
    reviewId,
    results: entries.map(entry => entry.adjusted),
  }
  await atomicWriteJson(sceneResultsPath, artifact)
  await runProcess(process.execPath, [join(skillRoot, 'scripts', 'match-scenes.mjs'), sceneResultsPath, productIndexPath, matchResultsPath], null, signal, 60_000)
  await atomicWriteJson(reviewPath, {
    version: 1,
    reviewId,
    createdAt: new Date().toISOString(),
    projectRoot: project.root,
    policyId: policy.policyId,
    skillId,
    entries,
  } satisfies ReviewArtifact)
  await atomicWriteJson(join(trainingDir, 'scene-angle-results.json'), artifact)
  await atomicWriteJson(join(trainingDir, 'footrest-matching-results.json'), JSON.parse(await readFile(matchResultsPath, 'utf8')))
  await atomicWriteJson(join(trainingDir, 'current-run.json'), {
    version: 1,
    runId: `review-${reviewId}`,
    reviewId,
    createdAt: new Date().toISOString(),
    sceneResultsPath: projectRelative(trainingDir, sceneResultsPath),
    matchResultsPath: projectRelative(trainingDir, matchResultsPath),
    source: 'human-review',
  })
  return {
    reviewId,
    reviewCount: entries.length,
    correctedCount: entries.filter(entry => entry.reviewState === 'corrected').length,
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function mergeJsonLinesInternal(path: string, cases: any[]): Promise<{ totalCount: number; writtenCount: number }> {
  let existing: any[] = []
  try {
    existing = (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }
  const byCaseId = new Map(existing.map(item => [item.caseId, item]))
  for (const item of cases) byCaseId.set(item.caseId, item)
  const serialized = [...byCaseId.values()]
    .sort((left, right) => String(left.caseId).localeCompare(String(right.caseId)))
    .map(item => JSON.stringify(item)).join('\n') + '\n'
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, serialized, 'utf8')
  await rename(temporaryPath, path)
  return { totalCount: byCaseId.size, writtenCount: cases.length }
}

async function mergeJsonLines(path: string, cases: any[]): Promise<{ totalCount: number; writtenCount: number }> {
  const previous = corpusWriteQueues.get(path) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(() => mergeJsonLinesInternal(path, cases))
  corpusWriteQueues.set(path, current)
  try {
    return await current
  } finally {
    if (corpusWriteQueues.get(path) === current) corpusWriteQueues.delete(path)
  }
}

async function mergeInlineOverride(
  path: string,
  scenePath: string,
  imageSha256: string,
  adjusted: any,
): Promise<void> {
  const previous = corpusWriteQueues.get(path) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(async () => {
    let artifact: InlineOverrideArtifact = { version: 1, updatedAt: new Date().toISOString(), results: {} }
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'))
      if (parsed?.version === 1 && parsed.results && typeof parsed.results === 'object') artifact = parsed
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }
    artifact.updatedAt = new Date().toISOString()
    artifact.results[scenePath] = { imageSha256, adjusted }
    await atomicWriteJson(path, artifact)
  })
  corpusWriteQueues.set(path, current)
  try {
    await current
  } finally {
    if (corpusWriteQueues.get(path) === current) corpusWriteQueues.delete(path)
  }
}

async function rerunInlineSkillMatch(
  project: ProjectScanResult,
  trainingDir: string,
  skillRoot: string,
  reviewId: string,
  createdAt: string,
  signal?: AbortSignal,
): Promise<{ runId: string; matchCount: number }> {
  const sourceArtifact = JSON.parse(await readFile(await currentSceneArtifactPath(trainingDir), 'utf8'))
  if (!Array.isArray(sourceArtifact.results)) throw new Error('当前识别结果缺少 results')

  let overrides: InlineOverrideArtifact = { version: 1, updatedAt: createdAt, results: {} }
  try {
    const parsed = JSON.parse(await readFile(join(trainingDir, 'inline-overrides.json'), 'utf8'))
    if (parsed?.version === 1 && parsed.results && typeof parsed.results === 'object') overrides = parsed
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }

  const absoluteByRelative = new Map(project.scenes.map(scenePath => [
    projectRelative(project.root, scenePath),
    scenePath,
  ]))
  const results = await Promise.all(sourceArtifact.results.map(async (item: any) => {
    if (!item || typeof item.scenePath !== 'string') return item
    const override = overrides.results[item.scenePath]
    const absoluteScene = absoluteByRelative.get(item.scenePath)
    if (!override?.adjusted || !absoluteScene || override.imageSha256 !== await sha256File(absoluteScene)) return item
    return { ...override.adjusted, scenePath: item.scenePath }
  }))

  const runId = `inline-${reviewId}`
  const runDir = join(trainingDir, 'runs', runId)
  const sceneResultsPath = join(runDir, 'scene-angle-results.json')
  const matchResultsPath = join(runDir, 'footrest-matching-results.json')
  const productIndexPath = await productIndexArtifactPath(trainingDir, skillRoot)
  const artifact = {
    ...sourceArtifact,
    source: 'human-inline-review',
    createdAt,
    reviewId,
    results,
  }
  await atomicWriteJson(sceneResultsPath, artifact)
  await runProcess(
    process.execPath,
    [join(skillRoot, 'scripts', 'match-scenes.mjs'), sceneResultsPath, productIndexPath, matchResultsPath],
    null,
    signal,
    60_000,
  )
  const matchArtifact = JSON.parse(await readFile(matchResultsPath, 'utf8'))
  await atomicWriteJson(join(trainingDir, 'scene-angle-results.json'), artifact)
  await atomicWriteJson(join(trainingDir, 'footrest-matching-results.json'), matchArtifact)
  await atomicWriteJson(join(trainingDir, 'current-run.json'), {
    version: 1,
    runId,
    reviewId,
    createdAt,
    sceneResultsPath: projectRelative(trainingDir, sceneResultsPath),
    matchResultsPath: projectRelative(trainingDir, matchResultsPath),
    source: 'human-inline-review',
  })
  return {
    runId,
    matchCount: Array.isArray(matchArtifact.matches) ? matchArtifact.matches.length : 0,
  }
}

export async function saveInlineSkillTrainingReview(
  project: ProjectScanResult,
  input: SkillTrainingReviewInput,
  skillId = 'chair-angle-matcher',
  options: InlineTrainingOptions = {},
): Promise<{
  reviewId: string
  adjusted: any
  database: { corpusPath: string; writtenCount: number; totalCount: number }
  skill: { corpusPath: string; writtenCount: number; totalCount: number }
  rematch: { runId: string; matchCount: number }
}> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(skillId)) throw new Error('Invalid training Skill id')
  if (input.reviewState !== 'corrected') throw new Error('Inline training requires a corrected review')
  const absoluteScene = resolve(input.scenePath)
  if (!project.scenes.includes(absoluteScene)) throw new Error(`Scene does not belong to the current project: ${input.scenePath}`)

  const scenePath = projectRelative(project.root, absoluteScene)
  const trainingDir = join(project.root, '.scenecolor', 'skill-training')
  const sourceArtifact = JSON.parse(await readFile(await currentSceneArtifactPath(trainingDir), 'utf8'))
  const original = Array.isArray(sourceArtifact.results)
    ? sourceArtifact.results.find((item: any) => item.scenePath === scenePath)
    : null
  if (!original) throw new Error(`Current recognition result is missing scene: ${scenePath}`)

  const skillRoot = join(resolve(process.cwd()), 'skills', skillId)
  const policy = await loadChairDecisionPolicy(join(skillRoot, 'references', 'decision-policy.json'))
  const adjusted = adjustObservation(original, input, policy)
  const reviewId = randomUUID()
  const createdAt = new Date().toISOString()
  const reviewerNote = String(input.reviewerNote ?? '').slice(0, 1000)
  const entry: ReviewEntry = { scenePath, reviewState: 'corrected', reviewerNote, original, adjusted }
  const imageSha256 = await sha256File(absoluteScene)
  const projectId = createHash('sha256').update(project.root).digest('hex').slice(0, 16)
  const datasetId = `local-${basename(project.root).replace(/[^\p{L}\p{N}_-]+/gu, '-')}-${projectId}`
  const trainingCase = {
    schemaVersion: 2,
    caseId: `${policy.policyId}-${imageSha256.slice(0, 24)}`,
    datasetId,
    scenePath,
    imageSha256,
    perceptualGroupId: null,
    sourceGroupId: `sha256:${imageSha256}`,
    sourceImagePath: absoluteScene,
    cropParentId: null,
    split: 'retrieval',
    annotationStatus: 'adjudicated',
    retrievalEligible: true,
    labelPolicyVersion: policy.policyId,
    angleObservability: adjusted.angleObservability,
    coarseDirection: adjusted.coarseDirection,
    visibleParts: Object.fromEntries(PARTS.map(part => [part, adjusted.visibleParts?.[part] ?? 'unknown'])),
    angle: adjusted.angle,
    azimuth: adjusted.azimuth,
    imageFacingDirection: adjusted.imageFacingDirection,
    sceneMode: adjusted.sceneMode,
    chairCount: adjusted.chairCount,
    reclineState: adjusted.reclineState ?? 'unknown',
    instances: adjusted.instances ?? [],
    footrest: adjusted.footrest,
    reviewerDecision: 'corrected',
    reviewerNote,
    adjudicatedAt: createdAt,
    sourceProjectId: projectId,
    sourceReviewId: reviewId,
    previousObservation: {
      angleObservability: original.angleObservability,
      coarseDirection: original.coarseDirection,
      angle: original.angle,
      azimuth: original.azimuth,
      footrest: original.footrest,
    },
  }

  await atomicWriteJson(join(trainingDir, 'inline-reviews', `${reviewId}.json`), {
    version: 1,
    reviewId,
    createdAt,
    projectRoot: project.root,
    policyId: policy.policyId,
    skillId,
    entries: [entry],
  } satisfies ReviewArtifact)
  await mergeInlineOverride(join(trainingDir, 'inline-overrides.json'), scenePath, imageSha256, adjusted)
  const rematch = await rerunInlineSkillMatch(
    project,
    trainingDir,
    skillRoot,
    reviewId,
    createdAt,
    options.signal,
  )

  const databasePath = join(project.root, '.scenecolor', 'case-corpus', 'cases.jsonl')
  const skillPath = options.skillCorpusPath ?? join(skillRoot, 'references', 'training-cases.jsonl')
  const [databaseCounts, skillCounts] = await Promise.all([
    mergeJsonLines(databasePath, [trainingCase]),
    mergeJsonLines(skillPath, [trainingCase]),
  ])
  return {
    reviewId,
    adjusted,
    database: { corpusPath: databasePath, ...databaseCounts },
    skill: { corpusPath: skillPath, ...skillCounts },
    rematch,
  }
}

export async function saveInlineReferenceTraining(
  project: ProjectScanResult,
  input: ReferenceTrainingInput,
  skillId = 'chair-angle-matcher',
): Promise<{
  database: { corpusPath: string; writtenCount: number; totalCount: number }
  skill: { corpusPath: string; writtenCount: number; totalCount: number }
}> {
  const scenePath = resolve(input.scenePath)
  if (!project.scenes.includes(scenePath)) throw new Error('Reference feedback scene does not belong to the current project')
  const selected = [...new Set(input.selectedProductPaths ?? [])].map(path => resolve(path))
  const suggested = [...new Set(input.suggestedProductPaths ?? [])].map(path => resolve(path))
  if ([...selected, ...suggested].some(path => !project.products.includes(path))) {
    throw new Error('Reference feedback contains a product outside the current project')
  }

  const trainingDir = join(project.root, '.scenecolor', 'skill-training')
  const relativeScene = projectRelative(project.root, scenePath)
  const sourceArtifact = JSON.parse(await readFile(await currentSceneArtifactPath(trainingDir), 'utf8'))
  let observation = Array.isArray(sourceArtifact.results)
    ? sourceArtifact.results.find((item: any) => item.scenePath === relativeScene)
    : null
  try {
    const overrides = JSON.parse(await readFile(join(trainingDir, 'inline-overrides.json'), 'utf8')) as InlineOverrideArtifact
    observation = overrides.results?.[relativeScene]?.adjusted ?? observation
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!observation) throw new Error(`Current recognition result is missing scene: ${relativeScene}`)

  const sceneImageSha256 = await sha256File(scenePath)
  const productRecords = await Promise.all([...new Set([...selected, ...suggested])].map(async productPath => ({
    path: projectRelative(project.root, productPath),
    imageSha256: await sha256File(productPath),
  })))
  const productByPath = new Map(productRecords.map(item => [resolve(project.root, item.path), item]))
  const createdAt = new Date().toISOString()
  const projectId = createHash('sha256').update(project.root).digest('hex').slice(0, 16)
  const trainingCase = {
    schemaVersion: 1,
    caseId: `reference-${sceneImageSha256.slice(0, 24)}`,
    datasetId: `local-${basename(project.root).replace(/[^\p{L}\p{N}_-]+/gu, '-')}-${projectId}`,
    scenePath: relativeScene,
    sourceImagePath: scenePath,
    sceneImageSha256,
    angle: observation.angle,
    azimuth: observation.azimuth,
    angleObservability: observation.angleObservability,
    coarseDirection: observation.coarseDirection,
    sceneMode: observation.sceneMode,
    footrest: observation.footrest,
    selectedProducts: selected.map(path => productByPath.get(path)).filter(Boolean),
    rejectedProducts: suggested.filter(path => !selected.includes(path)).map(path => productByPath.get(path)).filter(Boolean),
    updatedAt: createdAt,
    sourceProjectId: projectId,
  }
  await atomicWriteJson(join(trainingDir, 'reference-feedback', `${sceneImageSha256}.json`), trainingCase)

  const databasePath = join(project.root, '.scenecolor', 'case-corpus', 'reference-cases.jsonl')
  const skillPath = join(resolve(process.cwd()), 'skills', skillId, 'references', 'reference-training-cases.jsonl')
  const [databaseCounts, skillCounts] = await Promise.all([
    mergeJsonLines(databasePath, [trainingCase]),
    mergeJsonLines(skillPath, [trainingCase]),
  ])
  return {
    database: { corpusPath: databasePath, ...databaseCounts },
    skill: { corpusPath: skillPath, ...skillCounts },
  }
}

async function readJsonLinesOrEmpty(path: string): Promise<any[]> {
  try {
    return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  } catch (error: any) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export async function getSkillTrainingReport(project: ProjectScanResult, skillId = 'chair-angle-matcher'): Promise<{
  projectCaseCount: number
  skillCaseCount: number
  referencePreferenceCount: number
  inlineReviewCount: number
  activeExampleCount: number
  lastActivityAt: string | null
  correctedByAngle: Record<string, number>
}> {
  const trainingDir = join(project.root, '.scenecolor', 'skill-training')
  const skillRoot = join(resolve(process.cwd()), 'skills', skillId)
  const [projectCases, skillCases, projectReferences, skillReferences, inlineReviews] = await Promise.all([
    readJsonLinesOrEmpty(join(project.root, '.scenecolor', 'case-corpus', 'cases.jsonl')),
    readJsonLinesOrEmpty(join(skillRoot, 'references', 'training-cases.jsonl')),
    readJsonLinesOrEmpty(join(project.root, '.scenecolor', 'case-corpus', 'reference-cases.jsonl')),
    readJsonLinesOrEmpty(join(skillRoot, 'references', 'reference-training-cases.jsonl')),
    readdir(join(trainingDir, 'inline-reviews')).catch((error: any) => error?.code === 'ENOENT' ? [] : Promise.reject(error)),
  ])
  const uniqueAngleCases = new Map([...skillCases, ...projectCases].map(item => [item.caseId, item]))
  const uniqueReferenceCases = new Map([...skillReferences, ...projectReferences].map(item => [item.caseId, item]))
  const correctedByAngle: Record<string, number> = {}
  for (const item of uniqueAngleCases.values()) {
    if (item.reviewerDecision !== 'corrected') continue
    correctedByAngle[String(item.angle ?? 'unknown')] = (correctedByAngle[String(item.angle ?? 'unknown')] ?? 0) + 1
  }
  const times = [...uniqueAngleCases.values(), ...uniqueReferenceCases.values()]
    .map(item => item.adjudicatedAt ?? item.updatedAt)
    .filter((value): value is string => typeof value === 'string')
    .sort()
  return {
    projectCaseCount: projectCases.length,
    skillCaseCount: skillCases.length,
    referencePreferenceCount: uniqueReferenceCases.size,
    inlineReviewCount: inlineReviews.filter(name => name.endsWith('.json')).length,
    activeExampleCount: [...uniqueAngleCases.values()].filter(item => item.reviewerDecision === 'corrected' && typeof item.sourceImagePath === 'string').length,
    lastActivityAt: times[times.length - 1] ?? null,
    correctedByAngle,
  }
}

export async function publishSkillTrainingReview(
  project: ProjectScanResult,
  reviewId: string,
  target: PublishTarget,
): Promise<{ target: PublishTarget; corpusPath: string; writtenCount: number; totalCount: number }> {
  if (!/^[0-9a-f-]{36}$/i.test(reviewId)) throw new Error('训练复核 ID 无效')
  if (!['skill', 'database'].includes(target)) throw new Error('训练发布目标无效')
  const trainingDir = join(project.root, '.scenecolor', 'skill-training')
  const reviewPath = resolveInside(join(trainingDir, 'reviews'), `${reviewId}.json`)
  const artifact = JSON.parse(await readFile(reviewPath, 'utf8')) as ReviewArtifact
  if (artifact.version !== 1 || artifact.reviewId !== reviewId || artifact.projectRoot !== project.root
    || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(artifact.skillId)
    || !Array.isArray(artifact.entries) || artifact.entries.length !== project.scenes.length
    || artifact.entries.some(entry => !['confirmed', 'corrected'].includes(entry.reviewState) || !entry.adjusted)) {
    throw new Error('训练复核成果不完整或不属于当前项目')
  }
  const absoluteByRelative = new Map(project.scenes.map(path => [projectRelative(project.root, path), path]))
  const projectId = createHash('sha256').update(project.root).digest('hex').slice(0, 16)
  const datasetId = `local-${basename(project.root).replace(/[^\p{L}\p{N}_-]+/gu, '-')}-${projectId}`
  const cases = await Promise.all(artifact.entries.map(async entry => {
    const imagePath = absoluteByRelative.get(entry.scenePath)
    if (!imagePath) throw new Error(`复核成果包含未知场景：${entry.scenePath}`)
    const imageSha256 = await sha256File(imagePath)
    const item = entry.adjusted
    return {
      schemaVersion: 2,
      caseId: `${artifact.policyId}-${imageSha256.slice(0, 24)}`,
      datasetId,
      scenePath: entry.scenePath,
      imageSha256,
      perceptualGroupId: null,
      sourceGroupId: `sha256:${imageSha256}`,
      sourceImagePath: imagePath,
      cropParentId: null,
      split: 'retrieval',
      annotationStatus: 'adjudicated',
      retrievalEligible: true,
      labelPolicyVersion: artifact.policyId,
      angleObservability: item.angleObservability,
      coarseDirection: item.coarseDirection,
      visibleParts: Object.fromEntries(PARTS.map(part => [part, item.visibleParts?.[part] ?? 'unknown'])),
      angle: item.angle,
      azimuth: item.azimuth,
      imageFacingDirection: item.imageFacingDirection,
      sceneMode: item.sceneMode,
      chairCount: item.chairCount,
      reclineState: item.reclineState ?? 'unknown',
      instances: item.instances ?? [],
      footrest: item.footrest,
      reviewerDecision: entry.reviewState,
      reviewerNote: entry.reviewerNote,
      adjudicatedAt: artifact.createdAt,
      sourceProjectId: projectId,
      sourceReviewId: reviewId,
      previousObservation: entry.reviewState === 'corrected' ? {
        angleObservability: entry.original.angleObservability,
        coarseDirection: entry.original.coarseDirection,
        angle: entry.original.angle,
        azimuth: entry.original.azimuth,
        footrest: entry.original.footrest,
      } : null,
    }
  }))
  const corpusPath = target === 'skill'
    ? join(resolve(process.cwd()), 'skills', artifact.skillId, 'references', 'training-cases.jsonl')
    : join(project.root, '.scenecolor', 'case-corpus', 'cases.jsonl')
  const counts = await mergeJsonLines(corpusPath, cases)
  return { target, corpusPath, ...counts }
}
