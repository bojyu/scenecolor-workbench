import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isPathInside } from './projectAccess.js'

export interface GenerationInputHashes {
  scene: string
  product: string
  supporting: string[]
}

export interface GenerationInputBuffers {
  scene: Buffer
  product: Buffer
  supporting: Buffer[]
}

export interface GenerationAttempt {
  schemaVersion: 1
  attemptId: string
  createdAt: string
  projectRoot: string
  scenePath: string
  productPath: string
  supportingProductPaths: string[]
  outputPath: string
  inputHashes: GenerationInputHashes
  outputHash: string
  model: string
  resolution: string
  aspectRatio: string
  version: number
  prompt: string
  promptHash: string
  cached: boolean
}

interface AttemptIndexEntry {
  projectRoot: string
  attemptPath: string
}

interface AttemptIndex {
  version: 1
  updatedAt: string
  attempts: Record<string, AttemptIndexEntry>
}

export interface AttemptStorageOptions {
  stateRoot?: string
}

export interface LoadGenerationAttemptOptions extends AttemptStorageOptions {
  /**
   * When supplied, the project-local immutable record is authoritative and the
   * global index is only repaired as a cache.
   */
  projectRoot?: string
}

export type GenerationAttemptListMode = 'metadata' | 'audit'

export interface ListGenerationAttemptsOptions extends AttemptStorageOptions {
  /**
   * metadata avoids reading output image bytes. audit verifies every output
   * hash, with at most two full image reads in flight.
   */
  mode?: GenerationAttemptListMode
}

interface RecordGenerationAttemptBase {
  projectRoot: string
  scenePath: string
  productPath: string
  supportingProductPaths: string[]
  outputPath: string
  model: string
  resolution: string
  aspectRatio: string
  version: number
  prompt: string
  cached: boolean
}

type GenerationInputSnapshot =
  | {
      inputBuffers: GenerationInputBuffers
      inputHashes?: never
    }
  | {
      inputHashes: GenerationInputHashes
      inputBuffers?: never
    }
  | {
      inputBuffers?: undefined
      inputHashes?: undefined
    }

export type RecordGenerationAttemptInput = RecordGenerationAttemptBase & GenerationInputSnapshot

interface LocalAttemptRecord {
  attempt: GenerationAttempt
  attemptPath: string
}

const indexWriteQueue = { current: Promise.resolve() as Promise<unknown> }
const ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/i
const METADATA_READ_CONCURRENCY = 16
const AUDIT_READ_CONCURRENCY = 2

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, path)
}

function attemptIndexPath(options: AttemptStorageOptions = {}): string {
  return resolve(options.stateRoot || process.cwd(), '.scenecolor', 'generation-attempt-index.json')
}

function projectAttemptPath(projectRoot: string, attemptId: string): string {
  return join(resolve(projectRoot), '.scenecolor', 'generation-attempts', `${attemptId}.json`)
}

function emptyAttemptIndex(updatedAt = new Date().toISOString()): AttemptIndex {
  return { version: 1, updatedAt, attempts: {} }
}

function parseAttemptIndex(value: unknown): AttemptIndex | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<AttemptIndex>
  if (candidate.version !== 1 || !candidate.attempts || typeof candidate.attempts !== 'object') return null
  const attempts: AttemptIndex['attempts'] = {}
  for (const [attemptId, entry] of Object.entries(candidate.attempts)) {
    if (
      !ATTEMPT_ID_PATTERN.test(attemptId)
      || !entry
      || typeof entry !== 'object'
      || typeof (entry as AttemptIndexEntry).projectRoot !== 'string'
      || typeof (entry as AttemptIndexEntry).attemptPath !== 'string'
    ) continue
    attempts[attemptId] = {
      projectRoot: resolve((entry as AttemptIndexEntry).projectRoot),
      attemptPath: resolve((entry as AttemptIndexEntry).attemptPath),
    }
  }
  return {
    version: 1,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date(0).toISOString(),
    attempts,
  }
}

async function readAttemptIndex(options: AttemptStorageOptions): Promise<AttemptIndex | null> {
  try {
    return parseAttemptIndex(JSON.parse(await readFile(attemptIndexPath(options), 'utf8')))
  } catch {
    return null
  }
}

async function reconcileAttemptIndex(
  projectRoot: string,
  localRecords: LocalAttemptRecord[],
  options: AttemptStorageOptions,
): Promise<void> {
  const normalizedProjectRoot = resolve(projectRoot)
  const operation = indexWriteQueue.current.catch(() => undefined).then(async () => {
    const path = attemptIndexPath(options)
    const existing = await readAttemptIndex(options)
    const index = emptyAttemptIndex()

    // Preserve other projects from a healthy cache, but rebuild this project's
    // entries exclusively from validated local records.
    if (existing) {
      for (const [attemptId, entry] of Object.entries(existing.attempts)) {
        if (resolve(entry.projectRoot) !== normalizedProjectRoot) {
          index.attempts[attemptId] = entry
        }
      }
    }
    for (const { attempt, attemptPath } of localRecords) {
      index.attempts[attempt.attemptId] = {
        projectRoot: normalizedProjectRoot,
        attemptPath: resolve(attemptPath),
      }
    }
    await atomicWriteJson(path, index)
  })
  indexWriteQueue.current = operation
  await operation
}

async function updateAttemptIndex(
  attempt: GenerationAttempt,
  attemptPath: string,
  options: AttemptStorageOptions,
): Promise<void> {
  const operation = indexWriteQueue.current.catch(() => undefined).then(async () => {
    const path = attemptIndexPath(options)
    const index = await readAttemptIndex(options) || emptyAttemptIndex(attempt.createdAt)
    index.updatedAt = attempt.createdAt
    index.attempts[attempt.attemptId] = {
      projectRoot: attempt.projectRoot,
      attemptPath: resolve(attemptPath),
    }
    await atomicWriteJson(path, index)
  })
  indexWriteQueue.current = operation
  await operation
}

function assertAttemptId(attemptId: string): void {
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) throw new Error('生成尝试 ID 无效')
}

function normalizeInputHashes(hashes: GenerationInputHashes, expectedSupportingCount: number): GenerationInputHashes {
  if (
    !hashes
    || !SHA256_PATTERN.test(hashes.scene)
    || !SHA256_PATTERN.test(hashes.product)
    || !Array.isArray(hashes.supporting)
    || hashes.supporting.length !== expectedSupportingCount
    || hashes.supporting.some(hash => !SHA256_PATTERN.test(hash))
  ) {
    throw new Error('生成尝试的输入哈希快照无效')
  }
  return {
    scene: hashes.scene.toLowerCase(),
    product: hashes.product.toLowerCase(),
    supporting: hashes.supporting.map(hash => hash.toLowerCase()),
  }
}

async function resolveInputHashes(
  input: RecordGenerationAttemptInput,
  scenePath: string,
  productPath: string,
  supportingProductPaths: string[],
): Promise<GenerationInputHashes> {
  const snapshot = input as RecordGenerationAttemptBase & {
    inputBuffers?: GenerationInputBuffers
    inputHashes?: GenerationInputHashes
  }
  if (snapshot.inputHashes && snapshot.inputBuffers) {
    throw new Error('输入缓冲区快照和输入哈希快照不能同时传入')
  }
  if (snapshot.inputHashes) {
    return normalizeInputHashes(snapshot.inputHashes, supportingProductPaths.length)
  }
  if (snapshot.inputBuffers) {
    const { scene, product, supporting } = snapshot.inputBuffers
    if (
      !Buffer.isBuffer(scene)
      || !Buffer.isBuffer(product)
      || !Array.isArray(supporting)
      || supporting.length !== supportingProductPaths.length
      || supporting.some(buffer => !Buffer.isBuffer(buffer))
    ) {
      throw new Error('生成尝试的输入缓冲区快照无效')
    }
    return {
      scene: sha256(scene),
      product: sha256(product),
      supporting: supporting.map(buffer => sha256(buffer)),
    }
  }

  // Backward-compatible path for callers that do not yet capture inputs at
  // generation start.
  const [scene, product, ...supporting] = await Promise.all([
    readFile(scenePath),
    readFile(productPath),
    ...supportingProductPaths.map(path => readFile(path)),
  ])
  return {
    scene: sha256(scene),
    product: sha256(product),
    supporting: supporting.map(buffer => sha256(buffer)),
  }
}

function validateGenerationAttempt(
  value: unknown,
  attemptId: string,
  expectedProjectRoot: string,
): GenerationAttempt {
  if (!value || typeof value !== 'object') throw new Error('生成尝试记录无效')
  const attempt = value as GenerationAttempt
  const normalizedProjectRoot = resolve(expectedProjectRoot)
  if (
    attempt.schemaVersion !== 1
    || attempt.attemptId !== attemptId
    || resolve(attempt.projectRoot) !== normalizedProjectRoot
    || !Array.isArray(attempt.supportingProductPaths)
    || !isPathInside(normalizedProjectRoot, attempt.scenePath)
    || !isPathInside(normalizedProjectRoot, attempt.productPath)
    || !isPathInside(normalizedProjectRoot, attempt.outputPath)
    || attempt.supportingProductPaths.some(path => !isPathInside(normalizedProjectRoot, path))
  ) {
    throw new Error('生成尝试记录无效或包含越界路径')
  }
  normalizeInputHashes(attempt.inputHashes, attempt.supportingProductPaths.length)
  if (!SHA256_PATTERN.test(attempt.outputHash) || !SHA256_PATTERN.test(attempt.promptHash)) {
    throw new Error('生成尝试记录哈希无效')
  }
  return attempt
}

async function readLocalAttempt(projectRoot: string, attemptId: string): Promise<LocalAttemptRecord> {
  const normalizedProjectRoot = resolve(projectRoot)
  const expectedPath = projectAttemptPath(normalizedProjectRoot, attemptId)
  if (!isPathInside(normalizedProjectRoot, expectedPath)) throw new Error('生成尝试记录路径越界')

  // Resolve symlinks before reading so a project-local-looking path cannot
  // escape the supplied project root.
  const [canonicalRoot, canonicalAttemptPath] = await Promise.all([
    realpath(normalizedProjectRoot),
    realpath(expectedPath),
  ])
  if (!isPathInside(canonicalRoot, canonicalAttemptPath)) throw new Error('生成尝试记录路径越界')

  const parsed = JSON.parse(await readFile(canonicalAttemptPath, 'utf8'))
  const attempt = validateGenerationAttempt(parsed, attemptId, normalizedProjectRoot)
  return { attempt, attemptPath: expectedPath }
}

export async function recordGenerationAttempt(
  input: RecordGenerationAttemptInput,
  options: AttemptStorageOptions = {},
): Promise<GenerationAttempt> {
  const projectRoot = resolve(input.projectRoot)
  const scenePath = resolve(input.scenePath)
  const productPath = resolve(input.productPath)
  const outputPath = resolve(input.outputPath)
  const supportingProductPaths = input.supportingProductPaths.map(path => resolve(path))
  for (const path of [scenePath, productPath, outputPath, ...supportingProductPaths]) {
    if (!isPathInside(projectRoot, path)) throw new Error('生成尝试包含项目目录之外的文件')
  }

  const [inputHashes, output] = await Promise.all([
    resolveInputHashes(input, scenePath, productPath, supportingProductPaths),
    readFile(outputPath),
  ])
  const attemptId = randomUUID()
  const createdAt = new Date().toISOString()
  const attempt: GenerationAttempt = {
    schemaVersion: 1,
    attemptId,
    createdAt,
    projectRoot,
    scenePath,
    productPath,
    supportingProductPaths,
    outputPath,
    inputHashes,
    outputHash: sha256(output),
    model: input.model,
    resolution: input.resolution,
    aspectRatio: input.aspectRatio,
    version: input.version,
    prompt: input.prompt,
    promptHash: sha256(input.prompt),
    cached: input.cached,
  }
  const attemptPath = projectAttemptPath(projectRoot, attemptId)
  await atomicWriteJson(attemptPath, attempt)
  // The immutable project-local JSON is the commit point. The global index is
  // a rebuildable cache and must never turn a successful generation into an
  // apparent failure.
  await updateAttemptIndex(attempt, attemptPath, options).catch(() => undefined)
  return attempt
}

export async function loadGenerationAttempt(
  attemptId: string,
  options: LoadGenerationAttemptOptions = {},
): Promise<GenerationAttempt> {
  assertAttemptId(attemptId)

  if (options.projectRoot) {
    const localRecord = await readLocalAttempt(resolve(options.projectRoot), attemptId)
    await updateAttemptIndex(localRecord.attempt, localRecord.attemptPath, options).catch(() => undefined)
    return localRecord.attempt
  }

  const index = await readAttemptIndex(options)
  const entry = index?.attempts[attemptId]
  if (!entry) throw new Error('生成尝试不存在或全局索引已失效；请提供 projectRoot 以从项目记录恢复')

  const normalizedProjectRoot = resolve(entry.projectRoot)
  const expectedPath = projectAttemptPath(normalizedProjectRoot, attemptId)
  if (resolve(entry.attemptPath) !== resolve(expectedPath) || !isPathInside(normalizedProjectRoot, expectedPath)) {
    throw new Error('生成尝试索引路径越界或不是项目本地记录')
  }
  return (await readLocalAttempt(normalizedProjectRoot, attemptId)).attempt
}

export type GenerationAttemptIntegrity = 'unchecked' | 'valid' | 'missing' | 'mismatch'

export interface GenerationAttemptSummary {
  attemptId: string
  createdAt: string
  scenePath: string
  productPath: string
  supportingProductPaths: string[]
  outputPath: string
  outputHash: string
  model: string
  resolution: string
  aspectRatio: string
  version: number
  cached: boolean
  integrity: GenerationAttemptIntegrity
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(values[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function summarizeAttempt(
  attempt: GenerationAttempt,
  integrity: GenerationAttemptIntegrity,
): GenerationAttemptSummary {
  const {
    attemptId,
    createdAt,
    scenePath,
    productPath,
    supportingProductPaths,
    outputPath,
    outputHash,
    model,
    resolution,
    aspectRatio,
    version,
    cached,
  } = attempt
  return {
    attemptId,
    createdAt,
    scenePath,
    productPath,
    supportingProductPaths,
    outputPath,
    outputHash,
    model,
    resolution,
    aspectRatio,
    version,
    cached,
    integrity,
  }
}

async function auditOutputIntegrity(attempt: GenerationAttempt): Promise<GenerationAttemptIntegrity> {
  try {
    const output = await readFile(attempt.outputPath)
    return sha256(output) === attempt.outputHash ? 'valid' : 'mismatch'
  } catch (error: any) {
    if (error?.code === 'ENOENT') return 'missing'
    throw error
  }
}

export async function listProjectGenerationAttempts(
  requestedProjectRoot: string,
  options: ListGenerationAttemptsOptions = {},
): Promise<GenerationAttemptSummary[]> {
  const projectRoot = resolve(requestedProjectRoot)
  const attemptsDir = join(projectRoot, '.scenecolor', 'generation-attempts')
  let fileNames: string[]
  try {
    fileNames = await readdir(attemptsDir)
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      await reconcileAttemptIndex(projectRoot, [], options).catch(() => undefined)
      return []
    }
    throw error
  }

  const candidates = fileNames
    .filter(fileName => ATTEMPT_ID_PATTERN.test(fileName.replace(/\.json$/i, '')) && /\.json$/i.test(fileName))
  const localRecords = (await mapWithConcurrency(
    candidates,
    METADATA_READ_CONCURRENCY,
    async (fileName): Promise<LocalAttemptRecord | null> => {
      const attemptId = fileName.slice(0, -'.json'.length)
      try {
        return await readLocalAttempt(projectRoot, attemptId)
      } catch {
        return null
      }
    },
  )).filter((record): record is LocalAttemptRecord => Boolean(record))

  // One serialized atomic index update repairs missing, corrupt, stale and
  // incomplete cache entries without doing one write per attempt.
  await reconcileAttemptIndex(projectRoot, localRecords, options).catch(() => undefined)

  const mode = options.mode || 'metadata'
  let summaries: GenerationAttemptSummary[]
  if (mode === 'audit') {
    summaries = await mapWithConcurrency(
      localRecords,
      AUDIT_READ_CONCURRENCY,
      async ({ attempt }) => summarizeAttempt(attempt, await auditOutputIntegrity(attempt)),
    )
  } else {
    summaries = localRecords.map(({ attempt }) => summarizeAttempt(attempt, 'unchecked'))
  }

  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
