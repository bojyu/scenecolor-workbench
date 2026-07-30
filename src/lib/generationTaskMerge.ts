import type {
  GenerationAttemptSummary,
  WorkflowTaskProgress,
} from '../types'
import {
  createWorkflowProgress,
  updateWorkflowProgress,
} from './workflowProgress'

export type GenerationTaskStatus = 'idle' | 'queued' | 'running' | 'ok' | 'error' | 'cancelled'
export type GenerationTaskAttemptIntegrity = 'unchecked' | 'valid' | 'missing' | 'mismatch'

export interface GenerationTaskAttemptState {
  requestId: string
  batchId: string
  version: number
  status: Exclude<GenerationTaskStatus, 'idle'>
  createdAt: string
  completedAt?: string
  savedPath?: string
  attemptId?: string
  image?: string
  errorMsg?: string
  inputFingerprint?: string
  integrity?: GenerationTaskAttemptIntegrity
}

export interface GenerationTaskState {
  status: GenerationTaskStatus
  progress: WorkflowTaskProgress
  attempts: GenerationTaskAttemptState[]
  image?: string
  savedPath?: string
  attemptId?: string
  errorMsg?: string
  version?: number
  activeRequestId?: string
  pendingVersion?: number
  batchId?: string
  lastInputFingerprint?: string
}

export function successfulGenerationAttempts(
  task: GenerationTaskState,
): GenerationTaskAttemptState[] {
  const unique = new Map<string, GenerationTaskAttemptState>()
  for (const attempt of task.attempts) {
    if (attempt.status !== 'ok' || (!attempt.savedPath && !attempt.image)) continue
    const identity = `${attempt.version}|${attempt.savedPath || attempt.image}`
    unique.set(identity, attempt)
  }
  const attempts = [...unique.values()]
  if (attempts.length > 0) return attempts
  if (!task.savedPath && !task.image) return []
  return [{
    requestId: task.attemptId || `legacy-v${task.version || 1}`,
    batchId: task.batchId || 'legacy',
    version: task.version || 1,
    status: 'ok',
    createdAt: task.progress.createdAt,
    completedAt: task.progress.completedAt,
    savedPath: task.savedPath,
    attemptId: task.attemptId,
    image: task.image,
  }]
}

export function latestSuccessfulGenerationAttempt(
  task: GenerationTaskState,
): GenerationTaskAttemptState | undefined {
  const attempts = successfulGenerationAttempts(task)
    .slice()
    .sort((left, right) => left.version - right.version || left.createdAt.localeCompare(right.createdAt))
  return attempts[attempts.length - 1]
}

export function maxGenerationAttemptVersion(task: GenerationTaskState | undefined): number {
  if (!task) return 0
  return Math.max(
    task.version || 0,
    task.pendingVersion || 0,
    ...task.attempts.map(attempt => attempt.version),
    0,
  )
}

export function upsertGenerationTaskAttempt(
  attempts: GenerationTaskAttemptState[],
  nextAttempt: GenerationTaskAttemptState,
): GenerationTaskAttemptState[] {
  const index = attempts.findIndex(attempt => attempt.requestId === nextAttempt.requestId)
  if (index < 0) return [...attempts, nextAttempt]
  const next = attempts.slice()
  next[index] = { ...next[index], ...nextAttempt }
  return next
}

export function generationTaskProgress(
  current: WorkflowTaskProgress | undefined,
  status: GenerationTaskStatus,
  error?: string,
  incrementAttempt = false,
): WorkflowTaskProgress {
  const base = current || createWorkflowProgress('generation', {
    stage: 'queued',
    stageLabel: '等待生成',
    percent: 0,
  })
  if (status === 'queued') {
    return updateWorkflowProgress(base, {
      status: 'queued',
      stage: 'queued',
      stageLabel: '等待可用生成通道',
      percent: 0,
    })
  }
  if (status === 'running') {
    return updateWorkflowProgress(base, {
      status: 'running',
      stage: 'generating',
      stageLabel: '场景图生成中',
      percent: 35,
      incrementAttempt,
    })
  }
  if (status === 'ok') {
    return updateWorkflowProgress(base, {
      status: 'waiting-review',
      stage: 'result',
      stageLabel: '生成完成，等待确认',
      percent: 90,
    })
  }
  if (status === 'error') {
    return updateWorkflowProgress(base, {
      status: 'failed',
      stage: 'generating',
      stageLabel: '生成失败',
      percent: 35,
      error,
    })
  }
  if (status === 'cancelled') {
    return updateWorkflowProgress(base, {
      status: 'cancelled',
      stage: 'generating',
      stageLabel: '已停止，可重新执行',
      percent: 35,
    })
  }
  return updateWorkflowProgress(base, {
    status: 'queued',
    stage: 'queued',
    stageLabel: '等待生成',
    percent: 0,
  })
}

function integrityError(integrity: GenerationTaskAttemptIntegrity): string | undefined {
  if (integrity === 'missing') {
    return '历史生成记录存在，但原始输出文件已缺失'
  }
  if (integrity === 'mismatch') {
    return '历史输出已被旧版覆盖，已禁止把错误文件作为该版本预览'
  }
  return undefined
}

function findMatchingAttempt(
  attempts: GenerationTaskAttemptState[],
  summary: GenerationAttemptSummary,
): GenerationTaskAttemptState | undefined {
  return attempts.find(attempt => attempt.attemptId === summary.attemptId)
    || attempts.find(attempt => (
      !attempt.attemptId
      && (
        attempt.requestId === summary.attemptId
        || (
          attempt.version === summary.version
          && attempt.savedPath === summary.outputPath
        )
      )
    ))
}

function latestSuccessfulAttemptFromHistory(
  attempts: GenerationTaskAttemptState[],
): GenerationTaskAttemptState | undefined {
  return attempts
    .filter(attempt => attempt.status === 'ok' && Boolean(attempt.savedPath || attempt.image))
    .reduce<GenerationTaskAttemptState | undefined>((latest, attempt) => {
      if (!latest || attempt.version > latest.version) return attempt
      if (attempt.version === latest.version && attempt.createdAt > latest.createdAt) return attempt
      return latest
    }, undefined)
}

/**
 * Reconciles local queue history with the disk attempt ledger.
 *
 * Disk integrity is authoritative for completed attempts, while queued/running
 * control fields stay owned by the live worker so a scan cannot invalidate its
 * compare-and-swap completion update.
 */
export function mergeDiskGenerationAttempts(
  currentTasks: Map<string, GenerationTaskState>,
  summaries: GenerationAttemptSummary[],
  getPreviewUrl: (path: string) => string,
): Map<string, GenerationTaskState> {
  const next = new Map(currentTasks)
  const ordered = summaries.slice().sort((left, right) => left.createdAt.localeCompare(right.createdAt))

  for (const summary of ordered) {
    const key = `${summary.scenePath}|${summary.productPath}`
    const current = next.get(key)
    const isActive = current?.status === 'queued' || current?.status === 'running'
    const integrity = summary.integrity as GenerationTaskAttemptIntegrity
    const isUnchecked = integrity === 'unchecked'
    const isValid = integrity === 'valid'
    const errorMsg = integrityError(integrity)
    const matchingAttempt = findMatchingAttempt(current?.attempts || [], summary)
    const hasAuditedIntegrity = matchingAttempt?.integrity === 'valid'
      || matchingAttempt?.integrity === 'missing'
      || matchingAttempt?.integrity === 'mismatch'
    const attempt: GenerationTaskAttemptState = isUnchecked && hasAuditedIntegrity
      ? {
          ...matchingAttempt,
          attemptId: summary.attemptId,
        }
      : {
          requestId: matchingAttempt?.requestId || `disk:${summary.attemptId}`,
          batchId: matchingAttempt?.batchId || 'disk-history',
          version: summary.version,
          status: isUnchecked || isValid ? 'ok' : 'error',
          createdAt: summary.createdAt,
          completedAt: summary.createdAt,
          savedPath: isUnchecked || isValid ? summary.outputPath : undefined,
          attemptId: summary.attemptId,
          image: isUnchecked || isValid ? getPreviewUrl(summary.outputPath) : undefined,
          errorMsg,
          inputFingerprint: matchingAttempt?.inputFingerprint,
          integrity,
        }
    const attempts = upsertGenerationTaskAttempt(current?.attempts || [], attempt)
    const latestSuccess = latestSuccessfulAttemptFromHistory(attempts)
    const invalidatesStandaloneResult = !isUnchecked && !isValid && Boolean(
      current
      && (
        current.attemptId === summary.attemptId
        || (
          current.version === summary.version
          && current.savedPath === summary.outputPath
        )
      ),
    )
    const preserveStandaloneResult = !latestSuccess
      && !invalidatesStandaloneResult
      && Boolean(current?.savedPath || current?.image)
    const baseProgress = current?.progress || createWorkflowProgress('generation', {
      createdAt: summary.createdAt,
    })

    next.set(key, {
      ...current,
      status: isActive ? current.status : attempt.status,
      attempts,
      image: latestSuccess?.image || (preserveStandaloneResult ? current?.image : undefined),
      savedPath: latestSuccess?.savedPath || (preserveStandaloneResult ? current?.savedPath : undefined),
      attemptId: latestSuccess?.attemptId || (preserveStandaloneResult ? current?.attemptId : undefined),
      version: latestSuccess?.version || (preserveStandaloneResult ? current?.version : undefined),
      activeRequestId: isActive ? current.activeRequestId : undefined,
      pendingVersion: isActive ? current.pendingVersion : undefined,
      errorMsg: isActive ? current.errorMsg : errorMsg,
      progress: isActive
        ? current.progress
        : generationTaskProgress(baseProgress, attempt.status, errorMsg),
    })
  }

  return next
}
