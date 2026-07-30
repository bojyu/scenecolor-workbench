export const GENERATION_TASK_SCHEMA_VERSION = 1
export const GENERATION_TASK_STORAGE_PREFIX = 'scenecolor_generation_tasks'

export type GenerationJobStatus = 'queued' | 'running' | 'ok' | 'error' | 'cancelled'
export type GenerationAttemptStatus = 'running' | 'ok' | 'error' | 'cancelled'
export type GenerationAttemptIntegrity = 'unchecked' | 'valid' | 'missing' | 'mismatch'

export type GenerationSnapshotValue =
  | string
  | number
  | boolean
  | null
  | GenerationSnapshotValue[]
  | { [key: string]: GenerationSnapshotValue }

export type GenerationInputSnapshot = Readonly<Record<string, GenerationSnapshotValue>>

export interface GenerationAttempt {
  requestId: string
  attemptId?: string
  version: number
  status: GenerationAttemptStatus
  createdAt: string
  updatedAt: string
  savedPath?: string
  previewPath?: string
  error?: string
  integrity?: GenerationAttemptIntegrity
}

export interface GenerationJob {
  jobId: string
  fingerprint: string
  snapshot: GenerationInputSnapshot
  status: GenerationJobStatus
  attempts: GenerationAttempt[]
  createdAt: string
  updatedAt: string
  claimedBy?: string
  activeRequestId?: string
  latestSuccessfulRequestId?: string
}

export interface GenerationTaskEnvelope {
  schemaVersion: typeof GENERATION_TASK_SCHEMA_VERSION
  projectPath: string
  savedAt: string
  jobs: GenerationJob[]
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

export interface EnqueueResult {
  jobs: GenerationJob[]
  job: GenerationJob
  added: boolean
}

export interface ClaimResult {
  jobs: GenerationJob[]
  job?: GenerationJob
}

export type GenerationQueueAction =
  | { type: 'enqueue'; snapshot: Record<string, unknown>; now?: string; jobId?: string }
  | { type: 'claim-next'; workerId: string; now?: string }
  | { type: 'upsert-attempt'; jobId: string; attempt: GenerationAttempt }
  | { type: 'cancel'; jobId: string; now?: string; reason?: string }

const JOB_STATUSES = new Set<GenerationJobStatus>(['queued', 'running', 'ok', 'error', 'cancelled'])
const ATTEMPT_STATUSES = new Set<GenerationAttemptStatus>(['running', 'ok', 'error', 'cancelled'])
const ACTIVE_JOB_STATUSES = new Set<GenerationJobStatus>(['queued', 'running'])
const INTERRUPTED_MESSAGE = '页面刷新，未完成的生成任务已取消'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isUnsafeTransientUrl(value: string): boolean {
  const normalized = value.trimStart().toLowerCase()
  return normalized.startsWith('data:') || normalized.startsWith('blob:')
}

/**
 * Produces JSON-safe data and deliberately removes in-memory media URLs.
 * File paths and HTTP thumbnail URLs are retained.
 */
export function sanitizeGenerationMetadata(value: unknown): GenerationSnapshotValue | undefined {
  if (value === null) return null
  if (typeof value === 'string') return isUnsafeTransientUrl(value) ? undefined : value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    const compact: GenerationSnapshotValue[] = []
    for (const item of value) {
      const sanitized = sanitizeGenerationMetadata(item)
      if (sanitized !== undefined) compact.push(sanitized)
    }
    return compact
  }
  if (!isRecord(value)) return undefined

  const compact: Record<string, GenerationSnapshotValue> = {}
  for (const [key, item] of Object.entries(value)) {
    const sanitized = sanitizeGenerationMetadata(item)
    if (sanitized !== undefined) compact[key] = sanitized
  }
  return compact
}

function stableSerialize(value: GenerationSnapshotValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableSerialize(value[key])}`
  )).join(',')}}`
}

function fnv1a32(value: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function shortHash(value: string): string {
  const first = fnv1a32(value)
  const second = fnv1a32(value, 0x9e3779b9)
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`
}

export function snapshotGenerationInput(input: Record<string, unknown>): GenerationInputSnapshot {
  const sanitized = sanitizeGenerationMetadata(input)
  return isRecord(sanitized) ? sanitized : {}
}

export function createInputFingerprint(input: Record<string, unknown>): string {
  const snapshot = snapshotGenerationInput(input)
  return `gen_${shortHash(stableSerialize(snapshot))}`
}

function nowIso(now?: string): string {
  return now || new Date().toISOString()
}

export function createGenerationJob(
  input: Record<string, unknown>,
  options: { now?: string; jobId?: string } = {},
): GenerationJob {
  const snapshot = snapshotGenerationInput(input)
  const fingerprint = createInputFingerprint(snapshot)
  const createdAt = nowIso(options.now)
  return {
    jobId: options.jobId || `${fingerprint}_${shortHash(createdAt)}`,
    fingerprint,
    snapshot,
    status: 'queued',
    attempts: [],
    createdAt,
    updatedAt: createdAt,
  }
}

export function getLatestSuccessfulAttempt(job: GenerationJob): GenerationAttempt | undefined {
  return job.attempts
    .filter((attempt) => attempt.status === 'ok' && Boolean(attempt.savedPath))
    .reduce<GenerationAttempt | undefined>((latest, attempt) => {
      if (!latest || attempt.version > latest.version) return attempt
      if (attempt.version === latest.version && attempt.updatedAt > latest.updatedAt) return attempt
      return latest
    }, undefined)
}

export function getNextAttemptVersion(job: Pick<GenerationJob, 'attempts'>): number {
  const highest = job.attempts.reduce((max, attempt) => Math.max(max, attempt.version), 0)
  return highest + 1
}

export function createGenerationAttempt(
  job: Pick<GenerationJob, 'jobId' | 'attempts'>,
  options: { now?: string; requestId?: string; attemptId?: string } = {},
): GenerationAttempt {
  const createdAt = nowIso(options.now)
  const version = getNextAttemptVersion(job)
  return {
    requestId: options.requestId || `${job.jobId}_v${version}`,
    attemptId: options.attemptId,
    version,
    status: 'running',
    createdAt,
    updatedAt: createdAt,
  }
}

export function upsertGenerationAttempt(job: GenerationJob, attempt: GenerationAttempt): GenerationJob {
  const existingIndex = job.attempts.findIndex((item) => item.requestId === attempt.requestId)
  const attempts = existingIndex < 0
    ? [...job.attempts, { ...attempt }]
    : job.attempts.map((item, index) => index === existingIndex ? { ...item, ...attempt } : item)
  const nextStatus: GenerationJobStatus = attempt.status
  const updated: GenerationJob = {
    ...job,
    status: nextStatus,
    attempts,
    updatedAt: attempt.updatedAt,
    activeRequestId: attempt.status === 'running' ? attempt.requestId : undefined,
    claimedBy: attempt.status === 'running' ? job.claimedBy : undefined,
  }
  const latestSuccess = getLatestSuccessfulAttempt(updated)
  return {
    ...updated,
    latestSuccessfulRequestId: latestSuccess?.requestId,
  }
}

export function enqueueGenerationJob(
  jobs: GenerationJob[],
  input: Record<string, unknown>,
  options: { now?: string; jobId?: string } = {},
): EnqueueResult {
  const candidate = createGenerationJob(input, options)
  const duplicate = jobs.find((job) => (
    job.fingerprint === candidate.fingerprint && ACTIVE_JOB_STATUSES.has(job.status)
  ))
  if (duplicate) return { jobs, job: duplicate, added: false }
  return { jobs: [...jobs, candidate], job: candidate, added: true }
}

export function claimNextGenerationJob(
  jobs: GenerationJob[],
  workerId: string,
  now?: string,
): ClaimResult {
  const queuedIndex = jobs.findIndex((job) => job.status === 'queued')
  if (queuedIndex < 0) return { jobs }

  const claimedAt = nowIso(now)
  const claimed: GenerationJob = {
    ...jobs[queuedIndex],
    status: 'running',
    claimedBy: workerId,
    updatedAt: claimedAt,
  }
  return {
    jobs: jobs.map((job, index) => index === queuedIndex ? claimed : job),
    job: claimed,
  }
}

export function cancelGenerationJob(
  job: GenerationJob,
  now?: string,
  reason = '任务已取消',
): GenerationJob {
  const cancelledAt = nowIso(now)
  const attempts = job.attempts.map((attempt) => (
    attempt.status === 'running'
      ? { ...attempt, status: 'cancelled' as const, updatedAt: cancelledAt, error: attempt.error || reason }
      : attempt
  ))
  const updated: GenerationJob = {
    ...job,
    status: 'cancelled',
    attempts,
    updatedAt: cancelledAt,
    claimedBy: undefined,
    activeRequestId: undefined,
  }
  return {
    ...updated,
    latestSuccessfulRequestId: getLatestSuccessfulAttempt(updated)?.requestId,
  }
}

export function generationQueueReducer(
  jobs: GenerationJob[],
  action: GenerationQueueAction,
): GenerationJob[] {
  switch (action.type) {
    case 'enqueue':
      return enqueueGenerationJob(jobs, action.snapshot, action).jobs
    case 'claim-next':
      return claimNextGenerationJob(jobs, action.workerId, action.now).jobs
    case 'upsert-attempt':
      return jobs.map((job) => (
        job.jobId === action.jobId ? upsertGenerationAttempt(job, action.attempt) : job
      ))
    case 'cancel':
      return jobs.map((job) => (
        job.jobId === action.jobId ? cancelGenerationJob(job, action.now, action.reason) : job
      ))
  }
}

function normalizeProjectPath(projectPath: string): string {
  return projectPath.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function generationTaskStorageKey(projectPath: string): string {
  return `${GENERATION_TASK_STORAGE_PREFIX}:v${GENERATION_TASK_SCHEMA_VERSION}:${shortHash(normalizeProjectPath(projectPath))}`
}

function parseAttempt(value: unknown): GenerationAttempt | undefined {
  if (!isRecord(value)) return undefined
  const hasExplicitRequestId = typeof value.requestId === 'string' && Boolean(value.requestId)
  const requestId = hasExplicitRequestId
    ? value.requestId as string
    : typeof value.attemptId === 'string' && value.attemptId
      ? value.attemptId
      : undefined
  if (!requestId) return undefined
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) return undefined
  if (typeof value.status !== 'string' || !ATTEMPT_STATUSES.has(value.status as GenerationAttemptStatus)) return undefined
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return undefined
  const integrity = value.integrity === 'unchecked'
    || value.integrity === 'valid'
    || value.integrity === 'missing'
    || value.integrity === 'mismatch'
    ? value.integrity
    : undefined
  return {
    requestId,
    // Legacy v1 records only had `attemptId`, but it was sometimes a client
    // request UUID. Treat it as an untrusted request identity until the disk
    // ledger supplies an explicit server attempt id.
    attemptId: hasExplicitRequestId && typeof value.attemptId === 'string' && value.attemptId
      ? value.attemptId
      : undefined,
    version: value.version,
    status: value.status as GenerationAttemptStatus,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    savedPath: typeof value.savedPath === 'string' && !isUnsafeTransientUrl(value.savedPath) ? value.savedPath : undefined,
    previewPath: typeof value.previewPath === 'string' && !isUnsafeTransientUrl(value.previewPath) ? value.previewPath : undefined,
    error: typeof value.error === 'string' ? value.error : undefined,
    integrity,
  }
}

function parseJob(value: unknown): GenerationJob | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.jobId !== 'string' || typeof value.fingerprint !== 'string') return undefined
  if (typeof value.status !== 'string' || !JOB_STATUSES.has(value.status as GenerationJobStatus)) return undefined
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return undefined
  const snapshot = snapshotGenerationInput(isRecord(value.snapshot) ? value.snapshot : {})
  const attempts = Array.isArray(value.attempts)
    ? value.attempts.map(parseAttempt).filter((attempt): attempt is GenerationAttempt => Boolean(attempt))
    : []
  const job: GenerationJob = {
    jobId: value.jobId,
    fingerprint: value.fingerprint,
    snapshot,
    status: value.status as GenerationJobStatus,
    attempts,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    claimedBy: typeof value.claimedBy === 'string' ? value.claimedBy : undefined,
    activeRequestId: typeof value.activeRequestId === 'string'
      ? value.activeRequestId
      : typeof value.activeAttemptId === 'string'
        ? value.activeAttemptId
        : undefined,
    latestSuccessfulRequestId: typeof value.latestSuccessfulRequestId === 'string'
      ? value.latestSuccessfulRequestId
      : typeof value.latestSuccessfulAttemptId === 'string'
        ? value.latestSuccessfulAttemptId
      : undefined,
  }
  return {
    ...job,
    latestSuccessfulRequestId: getLatestSuccessfulAttempt(job)?.requestId,
  }
}

export function restoreGenerationJobs(jobs: GenerationJob[], now?: string): GenerationJob[] {
  const restoredAt = nowIso(now)
  return jobs.map((job) => {
    const wasInterrupted = job.status === 'queued' || job.status === 'running'
    const attempts = job.attempts.map((attempt) => (
      attempt.status === 'running'
        ? {
            ...attempt,
            status: 'cancelled' as const,
            updatedAt: restoredAt,
            error: attempt.error || INTERRUPTED_MESSAGE,
          }
        : attempt
    ))
    const restored: GenerationJob = {
      ...job,
      status: wasInterrupted ? 'cancelled' : job.status,
      attempts,
      updatedAt: wasInterrupted ? restoredAt : job.updatedAt,
      claimedBy: undefined,
      activeRequestId: undefined,
    }
    return {
      ...restored,
      latestSuccessfulRequestId: getLatestSuccessfulAttempt(restored)?.requestId,
    }
  })
}

function getDefaultStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

export function saveGenerationTasks(
  projectPath: string,
  jobs: GenerationJob[],
  storage: StorageLike | undefined = getDefaultStorage(),
  now?: string,
): boolean {
  if (!storage || !projectPath.trim()) return false
  try {
    const sanitizedJobs = jobs.map((job) => parseJob(sanitizeGenerationMetadata(job))).filter(
      (job): job is GenerationJob => Boolean(job),
    )
    const envelope: GenerationTaskEnvelope = {
      schemaVersion: GENERATION_TASK_SCHEMA_VERSION,
      projectPath,
      savedAt: nowIso(now),
      jobs: sanitizedJobs,
    }
    storage.setItem(generationTaskStorageKey(projectPath), JSON.stringify(envelope))
    return true
  } catch {
    return false
  }
}

export function loadGenerationTasks(
  projectPath: string,
  storage: StorageLike | undefined = getDefaultStorage(),
  now?: string,
): GenerationJob[] {
  if (!storage || !projectPath.trim()) return []
  try {
    const raw = storage.getItem(generationTaskStorageKey(projectPath))
    if (!raw) return []
    const envelope: unknown = JSON.parse(raw)
    if (!isRecord(envelope) || envelope.schemaVersion !== GENERATION_TASK_SCHEMA_VERSION) return []
    if (typeof envelope.projectPath !== 'string') return []
    if (normalizeProjectPath(envelope.projectPath) !== normalizeProjectPath(projectPath)) return []
    if (!Array.isArray(envelope.jobs)) return []
    const jobs = envelope.jobs.map(parseJob).filter((job): job is GenerationJob => Boolean(job))
    return restoreGenerationJobs(jobs, now)
  } catch {
    return []
  }
}

export function clearGenerationTasks(
  projectPath: string,
  storage: StorageLike | undefined = getDefaultStorage(),
): boolean {
  if (!storage?.removeItem || !projectPath.trim()) return false
  try {
    storage.removeItem(generationTaskStorageKey(projectPath))
    return true
  } catch {
    return false
  }
}
