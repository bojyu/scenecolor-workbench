import type {
  WorkflowModule,
  WorkflowProgressStep,
  WorkflowStepStatus,
  WorkflowTaskProgress,
  WorkflowTaskStatus,
} from '../types'

const STEP_LABELS: Record<WorkflowModule, Array<[string, string]>> = {
  generation: [
    ['queued', '排队'],
    ['generating', '生成'],
    ['result', '结果'],
    ['handoff', '发送核验'],
  ],
  verification: [
    ['queued', '排队'],
    ['verifying', '自动核验'],
    ['review', '结果复核'],
    ['handoff', '发送重绘'],
  ],
  'detail-redraw': [
    ['configure', '配置目标'],
    ['locate', '智能定位'],
    ['crop', '安全裁切'],
    ['redraw', '局部重绘'],
    ['composite', '无缝合成'],
    ['complete', '完成'],
  ],
}

function stepStatus(index: number, activeIndex: number, status: WorkflowTaskStatus): WorkflowStepStatus {
  if (status === 'failed' && index === activeIndex) return 'failed'
  if (index < activeIndex || (status === 'completed' && index === activeIndex)) return 'completed'
  if (index === activeIndex && status !== 'queued' && status !== 'cancelled') return 'active'
  return 'pending'
}

export function createWorkflowProgress(
  module: WorkflowModule,
  options: {
    status?: WorkflowTaskStatus
    stage?: string
    stageLabel?: string
    percent?: number
    createdAt?: string
    attempt?: number
    error?: string
  } = {},
): WorkflowTaskProgress {
  const now = new Date().toISOString()
  const createdAt = options.createdAt || now
  const definitions = STEP_LABELS[module]
  const stage = options.stage || definitions[0][0]
  const activeIndex = Math.max(0, definitions.findIndex(([id]) => id === stage))
  const status = options.status || 'queued'
  return {
    module,
    status,
    stage,
    stageLabel: options.stageLabel || definitions[activeIndex][1],
    percent: Math.max(0, Math.min(100, options.percent ?? 0)),
    steps: definitions.map(([id, label], index) => ({ id, label, status: stepStatus(index, activeIndex, status) })),
    createdAt,
    updatedAt: now,
    startedAt: status === 'running' ? now : undefined,
    completedAt: status === 'completed' || status === 'failed' ? now : undefined,
    error: options.error,
    attempt: options.attempt || 1,
  }
}

export function updateWorkflowProgress(
  current: WorkflowTaskProgress,
  update: {
    status?: WorkflowTaskStatus
    stage?: string
    stageLabel?: string
    percent?: number
    error?: string
    incrementAttempt?: boolean
  },
): WorkflowTaskProgress {
  const now = new Date().toISOString()
  const status = update.status || current.status
  const stage = update.stage || current.stage
  const definitions = STEP_LABELS[current.module]
  const activeIndex = Math.max(0, definitions.findIndex(([id]) => id === stage))
  return {
    ...current,
    status,
    stage,
    stageLabel: update.stageLabel || definitions[activeIndex][1],
    percent: Math.max(0, Math.min(100, update.percent ?? current.percent)),
    steps: definitions.map(([id, label], index) => {
      const previous = current.steps.find(step => step.id === id)
      const nextStatus = stepStatus(index, activeIndex, status)
      return {
        id,
        label,
        status: nextStatus,
        startedAt: nextStatus === 'active' ? previous?.startedAt || now : previous?.startedAt,
        completedAt: nextStatus === 'completed' ? previous?.completedAt || now : previous?.completedAt,
      }
    }),
    updatedAt: now,
    startedAt: status === 'running' ? current.startedAt || now : current.startedAt,
    completedAt: status === 'completed' || status === 'failed' ? now : undefined,
    error: update.error,
    attempt: current.attempt + (update.incrementAttempt ? 1 : 0),
  }
}

export function createVerificationProgress(createdAt = new Date().toISOString()): WorkflowTaskProgress {
  return createWorkflowProgress('verification', { createdAt, stage: 'queued', stageLabel: '等待核验 Skill', percent: 0 })
}

export function createDetailRedrawProgress(createdAt = new Date().toISOString()): WorkflowTaskProgress {
  return createWorkflowProgress('detail-redraw', { createdAt, stage: 'configure', stageLabel: '等待配置修复目标', percent: 0 })
}

export function elapsedLabel(progress: WorkflowTaskProgress): string {
  const start = new Date(progress.startedAt || progress.createdAt).getTime()
  const end = new Date(progress.completedAt || progress.updatedAt).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '刚刚更新'
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}

export function ensureWorkflowProgress(progress: WorkflowTaskProgress | undefined, module: WorkflowModule, createdAt: string): WorkflowTaskProgress {
  return progress || createWorkflowProgress(module, { createdAt })
}
