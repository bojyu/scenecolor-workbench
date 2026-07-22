import { useState, useEffect, useCallback, useRef } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import Header from './components/Header'
import FolderMode from './components/FolderMode'
import SettingsModal from './components/SettingsModal'
import RuntimeControlPanel from './components/RuntimeControlPanel'
import SkillTraining from './components/SkillTraining'
import VerificationWorkbench from './components/VerificationWorkbench'
import DetailRedrawWorkbench from './components/DetailRedrawWorkbench'
import type { AppMode } from './components/Header'
import type { AiRuntimeStatus, DetailRedrawQueueItem, RuntimeSelection, VerificationQueueItem } from './types'
import { getAiRuntimeStatus } from './api/client'
import { createDetailRedrawProgress, createVerificationProgress, ensureWorkflowProgress, updateWorkflowProgress } from './lib/workflowProgress'
import {
  DETAIL_REDRAW_QUEUE_KEY,
  VERIFICATION_QUEUE_KEY,
  loadQueue,
  saveDetailRedrawQueue,
  saveVerificationQueue,
} from './lib/workflowStorage'

gsap.registerPlugin(useGSAP)

function parseStoredApiKeys(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === 'string' && key.trim().length > 0).slice(0, 3)
      : []
  } catch {
    return []
  }
}

function App() {
  const [mode, setMode] = useState<AppMode>(() => {
    const saved = localStorage.getItem('scenecolor_mode')
    return saved === 'training' || saved === 'verification' || saved === 'detail-redraw' ? saved : 'workbench'
  })
  const [nanoBananaApiKeys, setNanoBananaApiKeys] = useState<string[]>([])
  const [image2ApiKeys, setImage2ApiKeys] = useState<string[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const contentRef = useRef<HTMLElement>(null)
  const [runtimeStatus, setRuntimeStatus] = useState<AiRuntimeStatus | null>(null)
  const [runtimeLoading, setRuntimeLoading] = useState(true)
  const [verificationQueue, setVerificationQueue] = useState<VerificationQueueItem[]>(() =>
    loadQueue<VerificationQueueItem>(VERIFICATION_QUEUE_KEY).map(item => ({
      ...item,
      progress: ensureWorkflowProgress(item.progress, 'verification', item.queuedAt),
    })),
  )
  const [detailRedrawQueue, setDetailRedrawQueue] = useState<DetailRedrawQueueItem[]>(() =>
    loadQueue<DetailRedrawQueueItem>(DETAIL_REDRAW_QUEUE_KEY).map(item => ({
      ...item,
      progress: ensureWorkflowProgress(item.progress, 'detail-redraw', item.queuedAt),
    })),
  )
  const [runtimeSelection, setRuntimeSelection] = useState<RuntimeSelection>(() => {
    const saved = localStorage.getItem('scenecolor_runtime_selection')
    if (saved) {
      try { return JSON.parse(saved) as RuntimeSelection } catch {}
    }
    return { providerId: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high', skillId: 'chair-angle-matcher' }
  })

  useEffect(() => {
    setNanoBananaApiKeys(parseStoredApiKeys(localStorage.getItem('comfly_api_keys')))
    setImage2ApiKeys(parseStoredApiKeys(localStorage.getItem('comfly_image2_api_keys')))
  }, [])

  const refreshRuntime = useCallback(async () => {
    setRuntimeLoading(true)
    try {
      const status = await getAiRuntimeStatus()
      setRuntimeStatus(status)
      setRuntimeSelection(previous => ({
        providerId: status.providers.some(provider => provider.id === previous.providerId) ? previous.providerId : status.currentProviderId,
        model: status.models.some(model => model.id === previous.model) ? previous.model : status.currentModel,
        reasoningEffort: status.reasoningEfforts.some(effort => effort.id === previous.reasoningEffort) ? previous.reasoningEffort : status.currentReasoningEffort,
        skillId: status.skills.some(skill => skill.id === 'chair-angle-matcher') ? 'chair-angle-matcher' : status.skills[0]?.id || previous.skillId,
      }))
    } catch {
      setRuntimeStatus(null)
    } finally {
      setRuntimeLoading(false)
    }
  }, [])

  useEffect(() => { refreshRuntime() }, [refreshRuntime])

  useEffect(() => {
    localStorage.setItem('scenecolor_runtime_selection', JSON.stringify(runtimeSelection))
  }, [runtimeSelection])

  useEffect(() => { saveVerificationQueue(verificationQueue) }, [verificationQueue])
  useEffect(() => { saveDetailRedrawQueue(detailRedrawQueue) }, [detailRedrawQueue])

  const saveApiKeys = useCallback((nanoBananaKeys: string[], image2Keys: string[]) => {
    const normalizedNanoBananaKeys = nanoBananaKeys.slice(0, 3)
    const normalizedImage2Keys = image2Keys.slice(0, 3)
    setNanoBananaApiKeys(normalizedNanoBananaKeys)
    setImage2ApiKeys(normalizedImage2Keys)
    localStorage.setItem('comfly_api_keys', JSON.stringify(normalizedNanoBananaKeys))
    localStorage.setItem('comfly_image2_api_keys', JSON.stringify(normalizedImage2Keys))
  }, [])

  const handleModeChange = useCallback((nextMode: AppMode) => {
    setMode(nextMode)
    localStorage.setItem('scenecolor_mode', nextMode)
  }, [])

  const handleSendToVerification = useCallback((item: VerificationQueueItem) => {
    setVerificationQueue(previous => [{
      ...item,
      progress: item.progress || createVerificationProgress(item.queuedAt),
    }, ...previous.filter(existing => existing.id !== item.id)])
  }, [])

  const removeVerificationItem = useCallback((id: string) => {
    setVerificationQueue(previous => previous.filter(item => item.id !== id))
  }, [])

  const handleSendToDetailRedraw = useCallback((item: DetailRedrawQueueItem) => {
    setVerificationQueue(previous => previous.map(existing => existing.id === item.sourceVerificationId ? {
      ...existing,
      progress: updateWorkflowProgress(existing.progress, {
        status: 'completed',
        stage: 'handoff',
        stageLabel: '已确认并发送细节重绘',
        percent: 100,
      }),
    } : existing))
    setDetailRedrawQueue(previous => [{
      ...item,
      progress: item.progress || createDetailRedrawProgress(item.queuedAt),
    }, ...previous.filter(existing => existing.id !== item.id)])
  }, [])

  const updateDetailRedrawTargets = useCallback((id: string, targets: DetailRedrawQueueItem['requestedTargets']) => {
    setDetailRedrawQueue(previous => previous.map(item => item.id === id ? {
      ...item,
      requestedTargets: targets,
      progress: updateWorkflowProgress(item.progress, {
        status: 'queued',
        stage: 'configure',
        stageLabel: targets.length ? `已配置 ${targets.length} 个修复目标` : '等待配置修复目标',
        percent: targets.length ? 10 : 0,
      }),
    } : item))
  }, [])

  const removeDetailRedrawItem = useCallback((id: string) => {
    setDetailRedrawQueue(previous => previous.filter(item => item.id !== id))
  }, [])

  useGSAP(() => {
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo(
        '.mode-pane.is-active',
        { autoAlpha: 0, y: 10 },
        { autoAlpha: 1, y: 0, duration: 0.24, ease: 'power2.out', clearProps: 'transform,opacity,visibility' },
      )
    })
    return () => media.revert()
  }, { scope: contentRef, dependencies: [mode], revertOnUpdate: true })

  const runtimeReady = Boolean(runtimeStatus?.available && (runtimeSelection.providerId !== 'codex' || runtimeStatus.authenticated))

  return (
    <div className="app">
      <Header
        mode={mode}
        onModeChange={handleModeChange}
        onSettingsClick={() => setShowSettings(true)}
        keyCount={nanoBananaApiKeys.length + image2ApiKeys.length}
        verificationCount={verificationQueue.length}
        detailRedrawCount={detailRedrawQueue.length}
      />
      <main className="main" ref={contentRef}>
        <RuntimeControlPanel status={runtimeStatus} loading={runtimeLoading} value={runtimeSelection}
          onChange={setRuntimeSelection} onRefresh={refreshRuntime}
          context={mode === 'verification' ? 'verification' : mode === 'detail-redraw' ? 'detail-redraw' : 'default'} />
        <section className={`mode-pane ${mode === 'workbench' ? 'is-active' : ''}`} hidden={mode !== 'workbench'}>
          <FolderMode
            nanoBananaApiKeys={nanoBananaApiKeys}
            image2ApiKeys={image2ApiKeys}
            runtime={runtimeSelection}
            runtimeReady={runtimeReady}
            onSendToVerification={handleSendToVerification}
            queuedVerificationIds={new Set(verificationQueue.map(item => item.id))}
          />
        </section>
        <section className={`mode-pane ${mode === 'verification' ? 'is-active' : ''}`} hidden={mode !== 'verification'}>
          <VerificationWorkbench
            runtime={runtimeSelection}
            runtimeReady={runtimeReady}
            items={verificationQueue}
            onRemove={removeVerificationItem}
            onBackToWorkbench={() => handleModeChange('workbench')}
            onSendToDetailRedraw={handleSendToDetailRedraw}
            detailRedrawQueuedIds={new Set(detailRedrawQueue.map(item => item.id))}
          />
        </section>
        <section className={`mode-pane ${mode === 'detail-redraw' ? 'is-active' : ''}`} hidden={mode !== 'detail-redraw'}>
          <DetailRedrawWorkbench
            runtime={runtimeSelection}
            runtimeReady={runtimeReady}
            items={detailRedrawQueue}
            onRemove={removeDetailRedrawItem}
            onBackToVerification={() => handleModeChange('verification')}
            onUpdateTargets={updateDetailRedrawTargets}
          />
        </section>
        <section className={`mode-pane ${mode === 'training' ? 'is-active' : ''}`} hidden={mode !== 'training'}>
          <SkillTraining runtime={runtimeSelection} runtimeReady={runtimeReady} />
        </section>
      </main>
      {showSettings && (
        <SettingsModal
          nanoBananaApiKeys={nanoBananaApiKeys}
          image2ApiKeys={image2ApiKeys}
          onSave={saveApiKeys}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}

export default App
