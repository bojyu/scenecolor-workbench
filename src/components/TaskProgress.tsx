import { useRef } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { Check, ClockCountdown, WarningCircle, X } from '@phosphor-icons/react'
import type { WorkflowTaskProgress } from '../types'
import { elapsedLabel } from '../lib/workflowProgress'

interface Props {
  progress: WorkflowTaskProgress
  compact?: boolean
}

const STATUS_LABELS: Record<WorkflowTaskProgress['status'], string> = {
  queued: '等待中',
  running: '执行中',
  'waiting-review': '等待复核',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
}

export default function TaskProgress({ progress, compact = false }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const fillRef = useRef<HTMLSpanElement>(null)

  useGSAP(() => {
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.to(fillRef.current, {
        scaleX: progress.percent / 100,
        duration: 0.42,
        ease: 'power2.out',
        overwrite: true,
      })
      gsap.fromTo('.task-progress-status', { autoAlpha: 0.55, y: 3 }, {
        autoAlpha: 1,
        y: 0,
        duration: 0.2,
        ease: 'power1.out',
      })
    })
    return () => media.revert()
  }, { scope: rootRef, dependencies: [progress.percent, progress.status, progress.stage], revertOnUpdate: true })

  return (
    <div className={`task-progress task-progress--${progress.status} ${compact ? 'is-compact' : ''}`} ref={rootRef}>
      <div className="task-progress-heading">
        <div>
          <span className="task-progress-status">
            {progress.status === 'completed' ? <Check size={14} weight="bold" /> : progress.status === 'failed' ? <WarningCircle size={14} weight="fill" /> : progress.status === 'cancelled' ? <X size={14} weight="bold" /> : <ClockCountdown size={14} weight="bold" />}
            {STATUS_LABELS[progress.status]}
          </span>
          <strong>{progress.stageLabel}</strong>
        </div>
        <div className="task-progress-numbers"><strong>{progress.percent}%</strong><small>{elapsedLabel(progress)} · 第 {progress.attempt} 次</small></div>
      </div>

      <div className="task-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-label={`${progress.stageLabel} ${progress.percent}%`}>
        <span ref={fillRef} style={{ transform: `scaleX(${progress.percent / 100})` }} />
      </div>

      <div className="task-progress-steps">
        {progress.steps.map(step => (
          <div key={step.id} className={`task-progress-step is-${step.status}`}>
            <span>{step.status === 'completed' ? <Check size={11} weight="bold" /> : step.status === 'failed' ? <WarningCircle size={11} weight="fill" /> : null}</span>
            <small>{step.label}</small>
          </div>
        ))}
      </div>

      {progress.error && (
        <details className="task-progress-error">
          <summary><WarningCircle size={14} weight="fill" />查看失败原因</summary>
          <p>{progress.error}</p>
        </details>
      )}
    </div>
  )
}
