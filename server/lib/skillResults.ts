import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'path'
import type { ProjectScanResult } from './projectScanner.js'

export type SkillMatchStatus = 'auto' | 'review' | 'unmatched'
export type FootrestCapability = 'present' | 'absent' | 'unknown'
export type FootrestState = 'retracted' | 'partial' | 'extended' | 'not_applicable' | 'unknown'
export type SkillReferenceMode = 'single' | 'multi_view'

export interface SkillChairInstance {
  id: string
  angle: string
  azimuth: number | null
  confidence: number
  decisiveCue: string
  imageFacingDirection?: 'left' | 'right' | 'center'
  reclineState?: 'upright' | 'reclined' | 'unknown'
  footrest?: SkillSceneResult['footrest']
}

export interface SkillSupportingReference {
  anchorKey: string
  productPath: string | null
  angle: string
  azimuth: number | null
}

export interface SkillSceneResult {
  scenePath: string
  angle: string
  azimuth: number | null
  confidence: number
  occlusion: number
  chairCount: number
  matchable: boolean
  status: SkillMatchStatus
  decisiveCue: string
  imageFacingDirection?: 'left' | 'right' | 'center' | 'multiple' | 'unknown'
  angleObservability?: 'exact' | 'coarse' | 'none'
  coarseDirection?: 'front' | 'right' | 'back' | 'left' | 'unknown'
  reclineState?: 'upright' | 'reclined' | 'unknown'
  visibleParts?: Record<string, 'full' | 'partial' | 'hidden' | 'unknown'>
  sceneMode?: 'single' | 'multi_same_model' | 'multi_mixed'
  sameModelConfidence?: number
  instances?: SkillChairInstance[]
  footrest: {
    capability: FootrestCapability
    state: FootrestState
    visibility: number
    confidence: number
    decisiveCue: string
  }
}

export interface SkillMatchResult {
  scenePath: string
  groupName: string
  productPath: string | null
  angle: string
  azimuth: number | null
  footrestCapability: FootrestCapability
  footrestState: FootrestState
  observedFootrestCapability: FootrestCapability
  observedFootrestState: FootrestState
  footrestAssumedRetracted: boolean
  anchorKey: string | null
  mirrored: boolean
  capabilityFallback: boolean
  referenceMode: SkillReferenceMode
  supportingReferences: SkillSupportingReference[]
  angleDifference: number | null
  status: SkillMatchStatus
  reason: string
}

export interface SkillResultSummary {
  sceneCount: number
  matchCount: number
  autoCount: number
  reviewCount: number
  unmatchedCount: number
  mirroredCount: number
  blockedSceneCount: number
  externalApiCalls: number
  extendedSceneCount: number
  retractedSceneCount: number
  unknownSceneCount: number
  absentSceneCount: number
  multiViewSceneCount: number
  multiViewMatchCount: number
  capabilityFallbackCount: number
  assumedRetractedSceneCount: number
  assumedRetractedMatchCount: number
}

type CalibrationCase = Omit<SkillSceneResult, 'scenePath'> & { scenePath: string }

interface CalibrationArtifact {
  cases?: unknown
  results?: unknown
}

interface MatchArtifact {
  matches?: Array<{
    scenePath: string
    colorGroup?: string
    productPath: string | null
    angle: string
    azimuth: number | null
    footrestCapability?: FootrestCapability
    footrestState: FootrestState
    observedFootrestCapability?: FootrestCapability
    observedFootrestState?: FootrestState
    footrestAssumedRetracted?: boolean
    anchorKey: string | null
    mirrored: boolean
    capabilityFallback?: boolean
    referenceMode?: SkillReferenceMode
    supportingReferences?: SkillSupportingReference[]
    angleDifference: number | null
    status: SkillMatchStatus
    reason: string
  }>
  summary?: {
    statusCounts?: Partial<Record<SkillMatchStatus, number>>
    mirroredCount?: number
    blockedSceneCount?: number
    externalApiCalls?: number
    multiViewSceneCount?: number
    multiViewMatchCount?: number
    capabilityFallbackCount?: number
    assumedRetractedSceneCount?: number
    assumedRetractedMatchCount?: number
  }
}

interface CurrentRunArtifact {
  version: number
  sceneResultsPath: string
  matchResultsPath: string
}

interface InlineOverrideArtifact {
  version: number
  results?: Record<string, { imageSha256?: string; adjusted?: CalibrationCase }>
}

interface ReferenceTrainingCase {
  caseId: string
  sceneImageSha256?: string
  angle?: string
  sceneMode?: string
  footrest?: { state?: string }
  selectedProducts?: Array<{ imageSha256?: string }>
  updatedAt?: string
}

function pathKey(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/')
}

async function parseJson<T>(filePath: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new Error(`Skill 成果文件不存在：${filePath}`)
    throw new Error(`Skill 成果文件读取失败：${error?.message || '未知错误'}`)
  }
}

function resolveArtifactPath(trainingDir: string, artifactPath: string): string {
  const absolutePath = resolve(trainingDir, artifactPath)
  const relativePath = relative(trainingDir, absolutePath)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Current Skill run points outside its training directory: ${artifactPath}`)
  }
  return absolutePath
}

async function resolveCurrentRunArtifacts(trainingDir: string): Promise<{
  sceneResultsPath: string
  matchResultsPath: string
}> {
  const compatibility = {
    sceneResultsPath: resolve(trainingDir, 'scene-angle-results.json'),
    matchResultsPath: resolve(trainingDir, 'footrest-matching-results.json'),
  }
  try {
    const manifest = JSON.parse(await readFile(resolve(trainingDir, 'current-run.json'), 'utf8')) as CurrentRunArtifact
    if (manifest.version !== 1 || typeof manifest.sceneResultsPath !== 'string' || typeof manifest.matchResultsPath !== 'string') {
      throw new Error('Current Skill run manifest is invalid')
    }
    return {
      sceneResultsPath: resolveArtifactPath(trainingDir, manifest.sceneResultsPath),
      matchResultsPath: resolveArtifactPath(trainingDir, manifest.matchResultsPath),
    }
  } catch (error: any) {
    if (error?.code === 'ENOENT') return compatibility
    throw error
  }
}

function normalizeCalibrationCases(artifact: CalibrationArtifact): CalibrationCase[] {
  const sources = [artifact.cases, artifact.results].filter(Array.isArray) as unknown[][]
  for (const candidates of sources) {
    if (!candidates.length) continue
    const normalized = candidates.flatMap(candidate => {
      if (!candidate || typeof candidate !== 'object') return []
      const item = candidate as Record<string, any>
      const footrest = item.footrest
      const valid = typeof item.scenePath === 'string'
        && typeof item.angle === 'string'
        && typeof item.confidence === 'number'
        && typeof item.occlusion === 'number'
        && typeof item.chairCount === 'number'
        && typeof item.matchable === 'boolean'
        && ['auto', 'review', 'unmatched'].includes(item.status)
        && footrest && typeof footrest === 'object'
        && typeof footrest.capability === 'string'
        && typeof footrest.state === 'string'
        && typeof footrest.visibility === 'number'
        && typeof footrest.confidence === 'number'
      if (!valid) return []

      return [{
        ...item,
        decisiveCue: String(item.decisiveCue ?? item.reason ?? ''),
        footrest: {
          ...footrest,
          decisiveCue: String(footrest.decisiveCue ?? footrest.reason ?? ''),
        },
      } as CalibrationCase]
    })
    if (normalized.length === candidates.length) return normalized
  }
  return []
}

async function loadCalibrationCases(localPath: string, fallbackPath: string): Promise<CalibrationCase[]> {
  try {
    const localArtifact = await parseJson<CalibrationArtifact>(localPath)
    const localCases = normalizeCalibrationCases(localArtifact)
    if (localCases.length) return localCases
  } catch (error: any) {
    if (!error?.message?.startsWith('Skill 成果文件不存在')) throw error
  }

  const fallbackArtifact = await parseJson<CalibrationArtifact>(fallbackPath)
  const fallbackCases = normalizeCalibrationCases(fallbackArtifact)
  if (!fallbackCases.length) {
    throw new Error(`Skill 场景成果缺少可兼容的 cases/results 数据：${fallbackPath}`)
  }
  return fallbackCases
}

async function applyInlineOverrides(
  trainingDir: string,
  scenePaths: Map<string, string>,
  cases: CalibrationCase[],
): Promise<CalibrationCase[]> {
  let artifact: InlineOverrideArtifact
  try {
    artifact = JSON.parse(await readFile(resolve(trainingDir, 'inline-overrides.json'), 'utf8')) as InlineOverrideArtifact
  } catch (error: any) {
    if (error?.code === 'ENOENT') return cases
    throw error
  }
  if (artifact.version !== 1 || !artifact.results || typeof artifact.results !== 'object') return cases

  const byPath = new Map(cases.map(item => [item.scenePath, item]))
  for (const [scenePath, override] of Object.entries(artifact.results)) {
    const absolutePath = scenePaths.get(scenePath)
    if (!absolutePath || !override?.adjusted || typeof override.imageSha256 !== 'string') continue
    const currentHash = createHash('sha256').update(await readFile(absolutePath)).digest('hex')
    if (currentHash !== override.imageSha256) continue
    byPath.set(scenePath, { ...override.adjusted, scenePath })
  }
  return [...byPath.values()]
}

async function loadReferenceCases(paths: string[]): Promise<ReferenceTrainingCase[]> {
  const byCaseId = new Map<string, ReferenceTrainingCase>()
  for (const path of paths) {
    try {
      for (const line of (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean)) {
        const item = JSON.parse(line) as ReferenceTrainingCase
        if (typeof item.caseId === 'string') byCaseId.set(item.caseId, item)
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return [...byCaseId.values()]
}

async function resolveLearnedSelections(
  project: ProjectScanResult,
  sceneResults: SkillSceneResult[],
  skillId: string,
): Promise<Record<string, string[]>> {
  const cases = await loadReferenceCases([
    resolve(process.cwd(), 'skills', skillId, 'references', 'reference-training-cases.jsonl'),
    resolve(project.root, '.scenecolor', 'case-corpus', 'reference-cases.jsonl'),
  ])
  if (!cases.length) return {}

  const productByHash = new Map<string, string>()
  await Promise.all(project.products.map(async productPath => {
    productByHash.set(createHash('sha256').update(await readFile(productPath)).digest('hex'), productPath)
  }))
  const learned: Record<string, string[]> = {}
  for (const scene of sceneResults) {
    const sceneHash = createHash('sha256').update(await readFile(scene.scenePath)).digest('hex')
    const ranked = cases.map(item => {
      const exactImage = item.sceneImageSha256 === sceneHash
      const signalScore = Number(item.angle === scene.angle)
        + Number(item.sceneMode === (scene.sceneMode ?? 'single'))
        + Number(item.footrest?.state === scene.footrest.state)
      return { item, score: exactImage ? 100 : signalScore }
    }).filter(item => item.score >= 3)
      .sort((left, right) => right.score - left.score
        || String(right.item.updatedAt ?? '').localeCompare(String(left.item.updatedAt ?? '')))
    const best = ranked[0]?.item
    if (!best) continue
    const selected = (best.selectedProducts ?? []).flatMap(item => {
      const productPath = item.imageSha256 ? productByHash.get(item.imageSha256) : undefined
      return productPath ? [productPath] : []
    })
    if (selected.length || best.sceneImageSha256 === sceneHash) learned[scene.scenePath] = selected
  }
  return learned
}

/**
 * Loads the reviewed chair-angle + retractable-footrest artifacts and resolves
 * every relative image path against the already scanned project. Paths that are
 * not present in the scan are deliberately ignored.
 */
export async function loadChairSkillResults(project: ProjectScanResult, skillId = 'chair-angle-matcher'): Promise<{
  sceneResults: SkillSceneResult[]
  matches: SkillMatchResult[]
  summary: SkillResultSummary
  learnedSelections: Record<string, string[]>
}> {
  const trainingDir = resolve(project.root, '.scenecolor', 'skill-training')
  const currentArtifacts = await resolveCurrentRunArtifacts(trainingDir)
  const localSceneResultsPath = currentArtifacts.sceneResultsPath
  const defaultCalibrationPath = `${project.root}/../skills/chair-angle-matcher/references/calibration-cases.json`
  const matchPath = currentArtifacts.matchResultsPath
  const loadedCalibrationCases = await loadCalibrationCases(localSceneResultsPath, defaultCalibrationPath)
  const matchArtifact = await parseJson<MatchArtifact>(matchPath)

  const scenePaths = new Map(project.scenes.map(path => [pathKey(project.root, path), path]))
  const productPaths = new Map(project.products.map(path => [pathKey(project.root, path), path]))
  const calibrationCases = await applyInlineOverrides(trainingDir, scenePaths, loadedCalibrationCases)

  const sceneResults = calibrationCases.flatMap(item => {
    const scenePath = scenePaths.get(item.scenePath)
    return scenePath ? [{ ...item, scenePath }] : []
  })

  const matches = (matchArtifact.matches || []).flatMap(item => {
    const scenePath = scenePaths.get(item.scenePath)
    if (!scenePath) return []
    const productPath = item.productPath ? productPaths.get(item.productPath) || null : null
    return [{
      ...item,
      scenePath,
      productPath,
      footrestCapability: item.footrestCapability ?? 'unknown',
      observedFootrestCapability: item.observedFootrestCapability ?? item.footrestCapability ?? 'unknown',
      observedFootrestState: item.observedFootrestState ?? item.footrestState,
      footrestAssumedRetracted: item.footrestAssumedRetracted ?? false,
      capabilityFallback: item.capabilityFallback ?? false,
      referenceMode: item.referenceMode ?? 'single',
      supportingReferences: (item.supportingReferences ?? []).map(reference => ({
        ...reference,
        productPath: reference.productPath ? productPaths.get(reference.productPath) || null : null,
      })),
      groupName: productPath ? basename(dirname(productPath)) : (item.colorGroup || '未分组'),
    }]
  })

  const counts = matches.reduce((acc, item) => {
    acc[item.status] += 1
    return acc
  }, { auto: 0, review: 0, unmatched: 0 } as Record<SkillMatchStatus, number>)
  const assumedRetractedScenePaths = new Set(matches
    .filter(item => item.footrestAssumedRetracted && item.status !== 'unmatched')
    .map(item => item.scenePath))
  const footrestCounts = sceneResults.reduce((acc, item) => {
    if (item.footrest.capability === 'absent') acc.absent += 1
    else if (item.footrest.state === 'extended') acc.extended += 1
    else if (item.footrest.state === 'retracted') acc.retracted += 1
    else if (assumedRetractedScenePaths.has(item.scenePath)) acc.assumedRetracted += 1
    else acc.unknown += 1
    return acc
  }, { extended: 0, retracted: 0, assumedRetracted: 0, unknown: 0, absent: 0 })
  const learnedSelections = await resolveLearnedSelections(project, sceneResults, skillId)

  return {
    sceneResults,
    matches,
    learnedSelections,
    summary: {
      sceneCount: sceneResults.length,
      matchCount: matches.length,
      autoCount: counts.auto,
      reviewCount: counts.review,
      unmatchedCount: counts.unmatched,
      mirroredCount: matchArtifact.summary?.mirroredCount ?? matches.filter(item => item.mirrored).length,
      blockedSceneCount: matchArtifact.summary?.blockedSceneCount ?? 0,
      externalApiCalls: matchArtifact.summary?.externalApiCalls ?? 0,
      extendedSceneCount: footrestCounts.extended,
      retractedSceneCount: footrestCounts.retracted,
      unknownSceneCount: footrestCounts.unknown,
      absentSceneCount: footrestCounts.absent,
      multiViewSceneCount: matchArtifact.summary?.multiViewSceneCount
        ?? new Set(matches.filter(item => item.referenceMode === 'multi_view').map(item => item.scenePath)).size,
      multiViewMatchCount: matchArtifact.summary?.multiViewMatchCount
        ?? matches.filter(item => item.referenceMode === 'multi_view' && item.status !== 'unmatched').length,
      capabilityFallbackCount: matchArtifact.summary?.capabilityFallbackCount
        ?? matches.filter(item => item.capabilityFallback).length,
      assumedRetractedSceneCount: matchArtifact.summary?.assumedRetractedSceneCount
        ?? footrestCounts.assumedRetracted,
      assumedRetractedMatchCount: matchArtifact.summary?.assumedRetractedMatchCount
        ?? matches.filter(item => item.footrestAssumedRetracted && item.status !== 'unmatched').length,
    },
  }
}
