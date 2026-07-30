import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowsClockwise,
  CaretDown,
  Check,
  CheckCircle,
  DownloadSimple,
  Eye,
  FolderOpen,
  Funnel,
  ImageSquare,
  MagnifyingGlass,
  MagicWand,
  Robot,
  ShieldCheck,
  Stop,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import {
  analyzeProductAngles,
  analyzeSceneAngles,
  autoMatchAngles,
  generate,
  getProductAngles,
  getResultDownloadUrl,
  getSceneAngles,
  getThumbnailUrl,
  listGenerationAttempts,
  recognizeAnglesWithCodexSkill,
  saveInlineSkillTraining,
  saveReferenceTraining,
  scanFolder,
} from '../api/client'
import {
  AngleObservability,
  AngleMatch,
  CoarseDirection,
  ImageAspectRatio,
  ImageGenerationModel,
  ImageResolution,
  ProductAngleAnalysis,
  SceneAngle,
  SceneAngleAnalysis,
  SkillMatchResult,
  SkillResultSummary,
  SkillSceneResult,
  SkillTrainingReviewInput,
  RuntimeSelection,
  VerificationQueueItem,
} from '../types'
import TaskProgress from './TaskProgress'
import { createVerificationProgress, createWorkflowProgress, updateWorkflowProgress } from '../lib/workflowProgress'
import { buildSkillMapping } from '../lib/skillMapping'
import {
  createInputFingerprint,
  getLatestSuccessfulAttempt as getLatestPersistedAttempt,
  loadGenerationTasks,
  saveGenerationTasks,
  type GenerationJob as PersistedGenerationJob,
} from '../lib/generationQueue'
import {
  generationTaskProgress,
  latestSuccessfulGenerationAttempt as latestSuccessfulAttempt,
  maxGenerationAttemptVersion as maxAttemptVersion,
  mergeDiskGenerationAttempts as mergeDiskAttempts,
  successfulGenerationAttempts as successfulAttempts,
  upsertGenerationTaskAttempt as upsertAttempt,
  type GenerationTaskAttemptState as TaskAttemptState,
  type GenerationTaskState as TaskState,
  type GenerationTaskStatus as TaskStatus,
} from '../lib/generationTaskMerge'

interface Props {
  nanoBananaApiKeys: string[]
  image2ApiKeys: string[]
  runtime: RuntimeSelection
  runtimeReady: boolean
  onSendToVerification: (item: VerificationQueueItem) => void
  queuedVerificationIds: Set<string>
}

type SceneFilter = 'all' | 'review' | 'auto' | 'unmatched' | 'mirrored'
type InlineTrainingState = { status: 'saving' | 'saved' | 'error'; error?: string }

const IMAGE_ASPECT_RATIO_OPTIONS: ImageAspectRatio[] = [
  'auto', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
  '1:4', '4:1', '1:8', '8:1',
]

const PRIMARY_ASPECT_RATIO_OPTIONS: ImageAspectRatio[] = ['auto', '1:1', '4:3', '3:4', '16:9', '9:16']
const MORE_ASPECT_RATIO_OPTIONS = IMAGE_ASPECT_RATIO_OPTIONS.filter(
  ratio => !PRIMARY_ASPECT_RATIO_OPTIONS.includes(ratio),
)

gsap.registerPlugin(useGSAP)

interface GenerationJob {
  requestId: string
  batchId: string
  projectRoot: string
  key: string
  scene: string
  product: string
  version: number
  model: ImageGenerationModel
  resolution: ImageResolution
  aspectRatio: ImageAspectRatio
  supportingProductPaths: string[]
  customPrompt?: string
  createdAt: string
  inputFingerprint: string
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function ThumbnailImage({ src, alt, eager = false }: { src: string; alt: string; eager?: boolean }) {
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    setFailed(false)
    setRetry(0)
  }, [src])
  if (failed) {
    return (
      <button
        type="button"
        className="thumbnail-error"
        onClick={() => {
          setFailed(false)
          setRetry(value => value + 1)
        }}
      >
        <WarningCircle size={18} weight="fill" />
        预览加载失败，点击重试
      </button>
    )
  }
  const resolvedSrc = retry > 0 && !src.startsWith('data:')
    ? `${src}${src.includes('?') ? '&' : '?'}retry=${retry}`
    : src
  return (
    <img
      src={resolvedSrc}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      onError={() => setFailed(true)}
    />
  )
}

function serializeGenerationTasks(tasks: Map<string, TaskState>): PersistedGenerationJob[] {
  return [...tasks.entries()].map(([key, task]) => {
    const [scene, product] = key.split('|')
    const attempts = task.attempts
      .filter(attempt => attempt.status !== 'queued')
      .map(attempt => ({
        requestId: attempt.requestId,
        attemptId: attempt.attemptId,
        version: attempt.version,
        status: attempt.status === 'queued' ? 'cancelled' as const : attempt.status,
        createdAt: attempt.createdAt,
        updatedAt: attempt.completedAt || attempt.createdAt,
        savedPath: attempt.savedPath,
        error: attempt.errorMsg,
        integrity: attempt.integrity,
      }))
    const successful = attempts
      .filter(attempt => attempt.status === 'ok' && attempt.savedPath)
      .sort((left, right) => left.version - right.version || left.updatedAt.localeCompare(right.updatedAt))
    const latestSuccess = successful[successful.length - 1]
    const status = task.status === 'idle' ? 'cancelled' : task.status
    return {
      jobId: key,
      fingerprint: task.lastInputFingerprint || `legacy:${createInputFingerprint({ scene, product })}`,
      snapshot: { scene, product },
      status,
      attempts,
      createdAt: task.progress.createdAt,
      updatedAt: task.progress.updatedAt,
      activeRequestId: task.activeRequestId,
      latestSuccessfulRequestId: latestSuccess?.requestId,
    }
  })
}

function restoreGenerationTaskMap(projectRoot: string): Map<string, TaskState> {
  const restored = new Map<string, TaskState>()
  for (const job of loadGenerationTasks(projectRoot)) {
    const scene = typeof job.snapshot.scene === 'string' ? job.snapshot.scene : ''
    const product = typeof job.snapshot.product === 'string' ? job.snapshot.product : ''
    if (!scene || !product) continue
    const latest = getLatestPersistedAttempt(job)
    const status: TaskStatus = job.status
    const attempts: TaskAttemptState[] = job.attempts.map(attempt => ({
      requestId: attempt.requestId,
      batchId: 'restored',
      version: attempt.version,
      status: attempt.status,
      createdAt: attempt.createdAt,
      completedAt: attempt.updatedAt,
      savedPath: attempt.savedPath,
      attemptId: attempt.attemptId,
      image: attempt.savedPath ? getThumbnailUrl(attempt.savedPath, 640) : undefined,
      errorMsg: attempt.error,
      integrity: attempt.integrity,
      inputFingerprint: job.fingerprint.startsWith('legacy:') ? undefined : job.fingerprint,
    }))
    const error = attempts.slice().reverse().find(attempt => attempt.status === 'error')?.errorMsg
    const progressBase = createWorkflowProgress('generation', { createdAt: job.createdAt })
    restored.set(`${scene}|${product}`, {
      status,
      attempts,
      savedPath: latest?.savedPath,
      image: latest?.savedPath ? getThumbnailUrl(latest.savedPath, 640) : undefined,
      attemptId: latest?.attemptId,
      version: latest?.version,
      errorMsg: error,
      lastInputFingerprint: job.fingerprint.startsWith('legacy:') ? undefined : job.fingerprint,
      progress: generationTaskProgress(progressBase, status, error),
    })
  }
  return restored
}

const ANGLE_LABELS: Record<SceneAngle, string> = {
  front: '正面',
  front_right: '右前',
  right: '右侧',
  back_right: '右后',
  back: '背面',
  back_left: '左后',
  left: '左侧',
  front_left: '左前',
  multiple: '多椅子',
  unknown: '无法判断',
}

const ANGLE_PRESETS: Array<{ angle: Exclude<SceneAngle, 'multiple' | 'unknown'>; azimuth: number }> = [
  { angle: 'front', azimuth: 0 },
  { angle: 'front_right', azimuth: 45 },
  { angle: 'right', azimuth: 90 },
  { angle: 'back_right', azimuth: 135 },
  { angle: 'back', azimuth: 180 },
  { angle: 'back_left', azimuth: 225 },
  { angle: 'left', azimuth: 270 },
  { angle: 'front_left', azimuth: 315 },
]

const FOOTREST_LABELS = {
  retracted: '脚垫收起',
  partial: '脚垫半伸',
  extended: '脚垫伸出',
  not_applicable: '确认无脚垫',
  unknown: '脚垫待核验',
} as const

function toAngleMap(items: SceneAngleAnalysis[]): Map<string, SceneAngleAnalysis> {
  return new Map(items.map(item => [item.scenePath, item]))
}

function toProductAngleMap(items: ProductAngleAnalysis[]): Map<string, ProductAngleAnalysis> {
  return new Map(items.map(item => [item.productPath, item]))
}

function createInlineReview(item: SkillSceneResult): SkillTrainingReviewInput {
  return {
    scenePath: item.scenePath,
    reviewState: 'corrected',
    angleObservability: item.angleObservability ?? (item.azimuth == null ? 'none' : 'exact'),
    coarseDirection: item.coarseDirection ?? 'unknown',
    azimuth: item.azimuth,
    sceneMode: item.sceneMode ?? 'single',
    footrest: { ...item.footrest },
    instances: (item.instances ?? []).flatMap(instance => instance.azimuth == null ? [] : [{
      id: instance.id,
      azimuth: instance.azimuth,
      confidence: instance.confidence,
      decisiveCue: instance.decisiveCue,
      reclineState: instance.reclineState,
      footrest: instance.footrest,
    }]),
    reviewerNote: '',
  }
}

export default function FolderMode({ nanoBananaApiKeys, image2ApiKeys, runtime, runtimeReady, onSendToVerification, queuedVerificationIds }: Props) {
  const [folderPath, setFolderPath] = useState(() => localStorage.getItem('scenecolor_folder_path') || '')
  const [scenes, setScenes] = useState<string[]>([])
  const [products, setProducts] = useState<string[]>([])
  const [productGroups, setProductGroups] = useState<{ name: string; images: string[] }[]>([])
  const [sceneThumbs, setSceneThumbs] = useState<Map<string, string>>(new Map())
  const [productThumbs, setProductThumbs] = useState<Map<string, string>>(new Map())
  const [mapping, setMapping] = useState<Map<string, Set<string>>>(new Map())
  const [checkedScenes, setCheckedScenes] = useState<Set<string>>(new Set())
  const [prompts, setPrompts] = useState<Map<string, string>>(new Map())
  const [defaultPrompt, setDefaultPrompt] = useState('')
  const [aspectRatio, setAspectRatio] = useState<ImageAspectRatio>(() => {
    const saved = localStorage.getItem('scenecolor_image_aspect_ratio') as ImageAspectRatio | null
    return saved && IMAGE_ASPECT_RATIO_OPTIONS.includes(saved) ? saved : 'auto'
  })
  const [imageModel, setImageModel] = useState<ImageGenerationModel>(() =>
    localStorage.getItem('scenecolor_image_model') === 'gpt-image-2' ? 'gpt-image-2' : 'nano-banana-2',
  )
  const [imageResolution, setImageResolution] = useState<ImageResolution>(() => {
    const saved = localStorage.getItem('scenecolor_image_resolution')
    return saved === '1K' || saved === '2K' || saved === '4K' ? saved : '4K'
  })
  const [tasks, setTasks] = useState<Map<string, TaskState>>(new Map())
  const [filterGroup, setFilterGroup] = useState<string>('')
  const [activeScene, setActiveScene] = useState<string | null>(null)
  const [sceneFilter, setSceneFilter] = useState<SceneFilter>('all')
  const [productSearch, setProductSearch] = useState('')
  const [angleFilter, setAngleFilter] = useState<SceneAngle | 'all'>('all')
  const [previewProduct, setPreviewProduct] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [enqueuing, setEnqueuing] = useState(false)
  const [, setQueueRevision] = useState(0)
  const [scanError, setScanError] = useState('')
  const [redoPrompt, setRedoPrompt] = useState<Map<string, string>>(new Map())
  const [selectedAttemptVersions, setSelectedAttemptVersions] = useState<Map<string, number>>(new Map())
  const [sceneAngles, setSceneAngles] = useState<Map<string, SceneAngleAnalysis>>(new Map())
  const [productAngles, setProductAngles] = useState<Map<string, ProductAngleAnalysis>>(new Map())
  const [angleMatches, setAngleMatches] = useState<AngleMatch[]>([])
  const [angleAnalyzing, setAngleAnalyzing] = useState(false)
  const [productAngleAnalyzing, setProductAngleAnalyzing] = useState(false)
  const [angleError, setAngleError] = useState('')
  const [angleSummary, setAngleSummary] = useState('')
  const [skillLoading, setSkillLoading] = useState(false)
  const [skillScenes, setSkillScenes] = useState<Map<string, SkillSceneResult>>(new Map())
  const [skillMatches, setSkillMatches] = useState<SkillMatchResult[]>([])
  const [skillSummary, setSkillSummary] = useState<SkillResultSummary | null>(null)
  const [inlineReviewDraft, setInlineReviewDraft] = useState<SkillTrainingReviewInput | null>(null)
  const [inlineTrainingStates, setInlineTrainingStates] = useState<Map<string, InlineTrainingState>>(new Map())

  const tasksRef = useRef<Map<string, TaskState>>(new Map())
  const mappingRef = useRef<Map<string, Set<string>>>(new Map())
  const pendingJobsRef = useRef<GenerationJob[]>([])
  const activeJobKeysRef = useRef<Set<string>>(new Set())
  const workerPoolRef = useRef<Promise<void> | null>(null)
  const activeProjectRef = useRef('')
  const enqueuingRef = useRef(false)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const candidateScrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scanAbortRef = useRef<AbortController | null>(null)
  const historyAbortRef = useRef<AbortController | null>(null)
  const angleKeyCursorRef = useRef(0)
  const angleAbortRef = useRef<AbortController | null>(null)
  const productAngleAbortRef = useRef<AbortController | null>(null)
  const referenceTrainingTimersRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    localStorage.setItem('scenecolor_folder_path', folderPath)
  }, [folderPath])

  useEffect(() => () => {
    abortRef.current?.abort()
    pendingJobsRef.current = []
    activeJobKeysRef.current.clear()
    scanAbortRef.current?.abort()
    historyAbortRef.current?.abort()
    angleAbortRef.current?.abort()
    productAngleAbortRef.current?.abort()
    for (const timer of referenceTrainingTimersRef.current.values()) window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    localStorage.setItem('scenecolor_image_aspect_ratio', aspectRatio)
  }, [aspectRatio])

  useEffect(() => {
    localStorage.setItem('scenecolor_image_model', imageModel)
  }, [imageModel])

  useEffect(() => {
    localStorage.setItem('scenecolor_image_resolution', imageResolution)
  }, [imageResolution])

  const generationApiKeys = imageModel === 'gpt-image-2' ? image2ApiKeys : nanoBananaApiKeys

  useEffect(() => {
    const projectRoot = activeProjectRef.current
    if (projectRoot) saveGenerationTasks(projectRoot, serializeGenerationTasks(tasks))
  }, [tasks])

  useEffect(() => {
    mappingRef.current = mapping
  }, [mapping])

  const commitTasks = (update: (next: Map<string, TaskState>) => void) => {
    const next = new Map(tasksRef.current)
    update(next)
    tasksRef.current = next
    setTasks(next)
  }

  const replaceTasks = (next: Map<string, TaskState>) => {
    tasksRef.current = next
    setTasks(next)
  }

  const cancelActiveGeneration = () => {
    pendingJobsRef.current = []
    activeJobKeysRef.current.clear()
    abortRef.current?.abort()
    abortRef.current = null
    commitTasks(next => {
      for (const [key, task] of next) {
        if (task.status !== 'running' && task.status !== 'queued') continue
        next.set(key, {
          ...task,
          status: 'cancelled',
          activeRequestId: undefined,
          pendingVersion: undefined,
          progress: generationTaskProgress(task.progress, 'cancelled'),
        })
      }
    })
    setGenerating(false)
  }

  const hydrateGenerationHistory = async (projectRoot: string, signal?: AbortSignal) => {
    try {
      for (const mode of ['metadata', 'audit'] as const) {
        const diskAttempts = await listGenerationAttempts(projectRoot, mode, signal)
        if (signal?.aborted || activeProjectRef.current !== projectRoot) return
        replaceTasks(mergeDiskAttempts(
          tasksRef.current,
          diskAttempts,
          path => getThumbnailUrl(path, 640),
        ))
      }
    } catch (error: any) {
      if (error?.name !== 'AbortError') {
        // History recovery must not block the workbench. Missing/corrupt outputs
        // are surfaced by the audit merge when the endpoint is available.
      }
    }
  }

  const startGenerationHistoryHydration = (projectRoot: string) => {
    historyAbortRef.current?.abort()
    const controller = new AbortController()
    historyAbortRef.current = controller
    void hydrateGenerationHistory(projectRoot, controller.signal).finally(() => {
      if (historyAbortRef.current === controller) historyAbortRef.current = null
    })
  }

  const handleScan = async () => {
    if (!folderPath.trim()) return
    setScanError(''); setScanning(true); setFilterGroup('')

    scanAbortRef.current?.abort()
    const controller = new AbortController()
    scanAbortRef.current = controller

    try {
      const res = await scanFolder(folderPath.trim(), controller.signal)
      if (!res.success) throw new Error(res.error || '扫描失败')
      if (!res.scenes.length || !res.products.length) {
        throw new Error('未找到图片。请确保文件夹包含 scenes/ 和 products/ 子目录。')
      }

      const nextProjectRoot = res.root || folderPath.trim()
      const previousProjectRoot = activeProjectRef.current
      if (previousProjectRoot && previousProjectRoot !== nextProjectRoot) {
        cancelActiveGeneration()
      }
      activeProjectRef.current = nextProjectRoot
      if (previousProjectRoot !== nextProjectRoot) {
        replaceTasks(restoreGenerationTaskMap(nextProjectRoot))
        setSelectedAttemptVersions(new Map())
      }
      setFolderPath(nextProjectRoot)
      setMapping(new Map()); setPrompts(new Map())
      setRedoPrompt(new Map())
      setSceneAngles(new Map()); setProductAngles(new Map()); setAngleMatches([])
      setAngleError(''); setAngleSummary('')
      setSkillScenes(new Map()); setSkillMatches([]); setSkillSummary(null)
      setInlineReviewDraft(null); setInlineTrainingStates(new Map())
      setScenes(res.scenes); setProducts(res.products); setActiveScene(res.scenes[0] || null)
      setProductGroups(res.productGroups || [])
      setCheckedScenes(new Set(res.scenes))
      setSceneAngles(toAngleMap(res.sceneAngles || []))
      setProductAngles(toProductAngleMap(res.productAngles || []))
      setAngleMatches(res.angleMatches || [])
      applyMatchesToMapping(res.angleMatches || [])

      const allProducts = res.productGroups?.length ? res.productGroups.flatMap(g => g.images) : res.products
      const [sceneT, prodT] = await Promise.all([
        loadThumbs(res.scenes, 640, controller.signal),
        loadThumbs(allProducts, 160, controller.signal),
      ])
      setSceneThumbs(sceneT); setProductThumbs(prodT)
      startGenerationHistoryHydration(nextProjectRoot)
    } catch (e: any) {
      if (e?.name !== 'AbortError') setScanError(e.message || '扫描失败')
    } finally {
      if (scanAbortRef.current === controller) scanAbortRef.current = null
      setScanning(false)
    }
  }

  const handleCodexSkillRecognition = async () => {
    setScanError(''); setSkillLoading(true); setFilterGroup('')

    scanAbortRef.current?.abort()
    const controller = new AbortController()
    scanAbortRef.current = controller

    try {
      const res = await recognizeAnglesWithCodexSkill(folderPath.trim(), runtime, controller.signal)
      if (!res.success || !res.summary) throw new Error(res.error || 'Codex + Skill 角度识别失败')
      if (!res.scenes.length || !res.products.length) throw new Error('项目中没有可用图片')

      const nextProjectRoot = res.root || folderPath.trim()
      const previousProjectRoot = activeProjectRef.current
      if (previousProjectRoot && previousProjectRoot !== nextProjectRoot) {
        cancelActiveGeneration()
      }
      activeProjectRef.current = nextProjectRoot
      if (previousProjectRoot !== nextProjectRoot) {
        replaceTasks(restoreGenerationTaskMap(nextProjectRoot))
        setSelectedAttemptVersions(new Map())
      }
      setFolderPath(nextProjectRoot)
      setMapping(new Map()); setPrompts(new Map())
      setCheckedScenes(new Set()); setRedoPrompt(new Map())
      setSceneThumbs(new Map()); setProductThumbs(new Map())
      setProductAngles(new Map()); setAngleMatches([])
      setAngleError(''); setAngleSummary('')
      setInlineReviewDraft(null); setInlineTrainingStates(new Map())
      setScenes(res.scenes); setProducts(res.products); setActiveScene(res.scenes[0] || null)
      setProductGroups(res.productGroups || [])
      setCheckedScenes(new Set(res.scenes))
      setSkillScenes(new Map(res.sceneResults.map(item => [item.scenePath, item])))
      setSkillMatches(res.matches)
      setSkillSummary(res.summary)
      applySkillMatchesToMapping(res.matches, res.learnedSelections)

      const analyzedAngles: SceneAngleAnalysis[] = res.sceneResults.map(item => ({
        scenePath: item.scenePath,
        angle: item.angle,
        azimuth: item.azimuth,
        elevation: null,
        mirrored: false,
        occlusion: item.occlusion,
        confidence: item.confidence,
        chairCount: item.chairCount,
        reason: `${item.decisiveCue}；脚垫：${item.footrest.decisiveCue}`,
        source: 'agent',
        model: 'chair-angle-matcher skill',
        analyzedAt: '2026-07-13T00:00:00.000Z',
        imageHash: 'reviewed-skill-result',
      }))
      setSceneAngles(toAngleMap(analyzedAngles))
      const duration = res.recognition ? `，耗时 ${Math.max(1, Math.round(res.recognition.durationMs / 1000))} 秒` : ''
      setAngleSummary(`Codex + Skill：识别 ${res.summary.sceneCount} 张场景，完成 ${res.summary.matchCount} 组判断${duration}`)

      const allProducts = res.productGroups?.length
        ? res.productGroups.flatMap(group => group.images)
        : res.products
      const [sceneT, prodT] = await Promise.all([
        loadThumbs(res.scenes, 640, controller.signal),
        loadThumbs(allProducts, 180, controller.signal),
      ])
      setSceneThumbs(sceneT); setProductThumbs(prodT)
      startGenerationHistoryHydration(nextProjectRoot)
    } catch (e: any) {
      if (e?.name !== 'AbortError') setScanError(e.message || 'Codex + Skill 角度识别失败')
    } finally {
      if (scanAbortRef.current === controller) scanAbortRef.current = null
      setSkillLoading(false)
    }
  }

  const applyInlineReview = async () => {
    const review = inlineReviewDraft
    if (!review) return
    const scenePath = review.scenePath
    setInlineTrainingStates(previous => new Map(previous).set(scenePath, { status: 'saving' }))
    setInlineReviewDraft(null)
    try {
      const result = await saveInlineSkillTraining(folderPath.trim(), runtime, review)
      setSkillScenes(previous => new Map(previous).set(scenePath, result.adjusted))
      setSkillMatches(result.matches)
      setSkillSummary(result.summary)
      setMapping(previous => {
        const next = new Map(previous)
        const refreshed = buildSkillMapping(
          result.matches.filter(match => match.scenePath === scenePath),
          result.learnedSelections && scenePath in result.learnedSelections
            ? { [scenePath]: result.learnedSelections[scenePath] }
            : undefined,
        )
        const selected = refreshed.get(scenePath)
        if (selected?.size) next.set(scenePath, selected)
        else next.delete(scenePath)
        return next
      })
      setSceneAngles(previous => new Map(previous).set(scenePath, {
        scenePath,
        angle: result.adjusted.angle,
        azimuth: result.adjusted.azimuth,
        elevation: null,
        mirrored: false,
        occlusion: result.adjusted.occlusion,
        confidence: result.adjusted.confidence,
        chairCount: result.adjusted.chairCount,
        reason: result.adjusted.decisiveCue,
        source: 'manual',
        model: 'human-reviewed chair-angle-matcher',
        analyzedAt: new Date().toISOString(),
        imageHash: 'inline-human-review',
      }))
      const refreshedProducts = [...new Set(result.matches
        .filter(match => match.scenePath === scenePath)
        .flatMap(match => [
          ...(match.productPath ? [match.productPath] : []),
          ...match.supportingReferences.flatMap(reference => reference.productPath ? [reference.productPath] : []),
        ]))]
      const refreshedThumbs = await loadThumbs(refreshedProducts, 160)
      setProductThumbs(previous => new Map([...previous, ...refreshedThumbs]))
      setInlineTrainingStates(previous => new Map(previous).set(scenePath, { status: 'saved' }))
    } catch (error: any) {
      setInlineTrainingStates(previous => new Map(previous).set(scenePath, {
        status: 'error',
        error: error?.message || '后台学习保存失败',
      }))
    }
  }

  const loadThumbs = async (paths: string[], maxW: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const map = new Map(paths.map(path => [path, getThumbnailUrl(path, maxW)]))
    if (maxW >= 480) setSceneThumbs(new Map(map))
    else setProductThumbs(previous => new Map([...previous, ...map]))
    return map
  }

  const persistReferenceSelection = async (scenePath: string, selectedProductPaths: string[]) => {
    const suggestedProductPaths = skillMatches
      .filter(match => match.scenePath === scenePath)
      .flatMap(match => match.productPath ? [match.productPath] : [])
    setInlineTrainingStates(previous => new Map(previous).set(scenePath, { status: 'saving' }))
    try {
      await saveReferenceTraining(folderPath.trim(), runtime, { scenePath, selectedProductPaths, suggestedProductPaths })
      setInlineTrainingStates(previous => new Map(previous).set(scenePath, { status: 'saved' }))
    } catch (error: any) {
      setInlineTrainingStates(previous => new Map(previous).set(scenePath, {
        status: 'error', error: error?.message || '参考图选择保存失败',
      }))
      throw error
    }
  }

  const scheduleReferenceTraining = (scenePath: string, selectedProductPaths: string[]) => {
    const currentTimer = referenceTrainingTimersRef.current.get(scenePath)
    if (currentTimer) window.clearTimeout(currentTimer)
    const timer = window.setTimeout(async () => {
      referenceTrainingTimersRef.current.delete(scenePath)
      await persistReferenceSelection(scenePath, selectedProductPaths).catch(() => undefined)
    }, 600)
    referenceTrainingTimersRef.current.set(scenePath, timer)
  }

  const toggleProduct = (scene: string, product: string) => {
    const next = new Map(mappingRef.current)
    const selected = new Set(next.get(scene) || [])
    if (selected.has(product)) selected.delete(product); else selected.add(product)
    if (selected.size === 0) next.delete(scene); else next.set(scene, selected)
    mappingRef.current = next
    setMapping(next)
    scheduleReferenceTraining(scene, [...selected])
  }

  const applyMatchesToMapping = (matches: AngleMatch[]) => {
    const next = new Map<string, Set<string>>()
    for (const match of matches) {
      if (!match.productPath || match.status === 'unmatched') continue
      const selected = next.get(match.scenePath) || new Set<string>()
      selected.add(match.productPath)
      next.set(match.scenePath, selected)
    }
    mappingRef.current = next
    setMapping(next)
  }

  const applySkillMatchesToMapping = (matches: SkillMatchResult[], learnedSelections?: Record<string, string[]>) => {
    const next = buildSkillMapping(matches, learnedSelections)
    mappingRef.current = next
    setMapping(next)
  }

  const setScenePrompt = (scene: string, text: string) => {
    setPrompts(prev => {
      const next = new Map(prev)
      if (text.trim()) next.set(scene, text); else next.delete(scene)
      return next
    })
  }

  const toggleSceneChecked = (scene: string) => {
    setCheckedScenes(prev => {
      const next = new Set(prev)
      if (next.has(scene)) next.delete(scene); else next.add(scene)
      return next
    })
  }

  const selectAllScenes = () => setCheckedScenes(new Set(scenes))
  const deselectAllScenes = () => setCheckedScenes(new Set())
  const shortName = (p: string) => p.split(/[/\\]/).pop() || p

  const groupName = (prod: string) => {
    const g = productGroups.find(g => g.images.includes(prod))
    return g ? g.name : null
  }

  const nextAngleApiKey = () => {
    const key = nanoBananaApiKeys[angleKeyCursorRef.current % nanoBananaApiKeys.length] || ''
    angleKeyCursorRef.current += 1
    return key
  }

  const refreshSceneAngles = async () => {
    if (!scenes.length) return
    try {
      setSceneAngles(toAngleMap(await getSceneAngles(scenes)))
    } catch {}
  }

  const refreshProductAngles = async () => {
    if (!products.length) return
    try {
      setProductAngles(toProductAngleMap(await getProductAngles(products)))
    } catch {}
  }

  const refreshAngleMatches = async () => {
    if (!folderPath.trim()) return []
    const matches = await autoMatchAngles(folderPath.trim())
    setAngleMatches(matches)
    applyMatchesToMapping(matches)
    return matches
  }

  const supportingProductPathsFor = (scene: string, product: string): string[] => {
    const match = skillMatches.find(item => item.scenePath === scene && item.productPath === product)
    return match?.supportingReferences.flatMap(reference => reference.productPath ? [reference.productPath] : []) || []
  }

  const handleAnalyzeAngles = async () => {
    if (angleAnalyzing) {
      angleAbortRef.current?.abort()
      return
    }
    if (!nanoBananaApiKeys.length) {
      setAngleError('请先设置 API Key')
      return
    }
    const pending = scenes
      .filter(scene => checkedScenes.has(scene) && !sceneAngles.has(scene))
      .slice(0, 50)
    if (!pending.length) return

    const controller = new AbortController()
    angleAbortRef.current = controller
    setAngleAnalyzing(true); setAngleError(''); setAngleSummary('')
    try {
      const response = await analyzeSceneAngles(pending, nextAngleApiKey(), controller.signal)
      setSceneAngles(previous => {
        const next = new Map(previous)
        for (const result of response.results) next.set(result.scenePath, result)
        return next
      })
      const tokenText = response.totalTokens > 0 ? `，Token ${response.totalTokens}` : ''
      setAngleSummary(`新识别 ${response.callsMade} 张，缓存命中 ${response.cachedCount} 张${tokenText}`)
      if (response.errors.length) {
        setAngleError(`${response.errors.length} 张识别失败：${response.errors[0].error}`)
      }
      if (productAngles.size > 0) await refreshAngleMatches()
    } catch (e: any) {
      if (e?.name !== 'AbortError') setAngleError(e.message || '角度识别失败')
      else await refreshSceneAngles()
    } finally {
      if (angleAbortRef.current === controller) angleAbortRef.current = null
      setAngleAnalyzing(false)
    }
  }

  const handleAnalyzeProductAngles = async () => {
    if (productAngleAnalyzing) {
      productAngleAbortRef.current?.abort()
      return
    }
    const pending = products.filter(product => !productAngles.has(product)).slice(0, 50)
    if (pending.length > 0 && !nanoBananaApiKeys.length) {
      setAngleError('请先设置 API Key，或让 Agent 通过 MCP 完成图2角度识别')
      return
    }

    const controller = new AbortController()
    productAngleAbortRef.current = controller
    setProductAngleAnalyzing(true); setAngleError(''); setAngleSummary('')
    try {
      let productSummary = '图2素材已使用缓存'
      if (pending.length > 0) {
        const response = await analyzeProductAngles(pending, nextAngleApiKey(), controller.signal)
        setProductAngles(previous => {
          const next = new Map(previous)
          for (const result of response.results) next.set(result.productPath, result)
          return next
        })
        const tokenText = response.totalTokens > 0 ? `，Token ${response.totalTokens}` : ''
        productSummary = `图2新识别 ${response.callsMade} 张，缓存 ${response.cachedCount} 张${tokenText}`
        if (response.errors.length) setAngleError(`${response.errors.length} 张图2识别失败：${response.errors[0].error}`)
      }
      const matches = await refreshAngleMatches()
      const autoCount = matches.filter(match => match.status === 'auto').length
      const reviewCount = matches.filter(match => match.status === 'review').length
      setAngleSummary(`${productSummary}；自动匹配 ${autoCount} 组，待确认 ${reviewCount} 组`)
    } catch (e: any) {
      if (e?.name !== 'AbortError') setAngleError(e.message || '图2角度识别或匹配失败')
      else await refreshProductAngles()
    } finally {
      if (productAngleAbortRef.current === controller) productAngleAbortRef.current = null
      setProductAngleAnalyzing(false)
    }
  }

  const inputFingerprintFor = (
    scene: string,
    product: string,
    customPrompt = prompts.get(scene) || defaultPrompt || undefined,
  ) => createInputFingerprint({
    scene,
    product,
    supportingProductPaths: supportingProductPathsFor(scene, product),
    customPrompt: customPrompt || '',
    model: imageModel,
    resolution: imageResolution,
    aspectRatio,
  })

  const buildGenerationJob = (
    scene: string,
    product: string,
    version: number,
    batchId: string,
    customPrompt = prompts.get(scene) || defaultPrompt || undefined,
  ): GenerationJob => {
    const supportingProductPaths = supportingProductPathsFor(scene, product)
    return {
      requestId: createRequestId(),
      batchId,
      projectRoot: activeProjectRef.current || folderPath.trim(),
      key: `${scene}|${product}`,
      scene,
      product,
      version,
      model: imageModel,
      resolution: imageResolution,
      aspectRatio,
      supportingProductPaths,
      customPrompt,
      createdAt: new Date().toISOString(),
      inputFingerprint: createInputFingerprint({
        scene,
        product,
        supportingProductPaths,
        customPrompt: customPrompt || '',
        model: imageModel,
        resolution: imageResolution,
        aspectRatio,
      }),
    }
  }

  const runGenerationJob = async (job: GenerationJob, apiKey: string, signal: AbortSignal) => {
    if (signal.aborted || activeProjectRef.current !== job.projectRoot) return
    commitTasks(next => {
      const previous = next.get(job.key)
      if (!previous || previous.activeRequestId !== job.requestId) return
      const runningAttempt: TaskAttemptState = {
        requestId: job.requestId,
        batchId: job.batchId,
        version: job.version,
        status: 'running',
        createdAt: job.createdAt,
        inputFingerprint: job.inputFingerprint,
      }
      next.set(job.key, {
        ...previous,
        status: 'running',
        attempts: upsertAttempt(previous.attempts, runningAttempt),
        errorMsg: undefined,
        progress: generationTaskProgress(previous.progress, 'running', undefined, true),
      })
    })

    try {
      const response = await generate({
        scenePath: job.scene,
        productPath: job.product,
        apiKey,
        model: job.model,
        resolution: job.resolution,
        aspectRatio: job.aspectRatio,
        supportingProductPaths: job.supportingProductPaths,
        customPrompt: job.customPrompt,
        sceneFile: job.scene,
        productFile: job.product,
        version: job.version,
      }, signal)
      if (!response.success || (!response.savedPath && !response.image)) {
        throw new Error(response.error || '生成完成但结果没有成功落盘')
      }
      if (activeProjectRef.current !== job.projectRoot) return

      const actualVersion = response.version || job.version
      const preview = response.savedPath
        ? getThumbnailUrl(response.savedPath, 640)
        : response.image
      const completedAt = new Date().toISOString()
      commitTasks(next => {
        const current = next.get(job.key)
        if (!current || current.activeRequestId !== job.requestId) return
        const completedAttempt: TaskAttemptState = {
          requestId: job.requestId,
          batchId: job.batchId,
          version: actualVersion,
          status: 'ok',
          createdAt: job.createdAt,
          completedAt,
          savedPath: response.savedPath,
          attemptId: response.attemptId,
          image: preview,
          inputFingerprint: job.inputFingerprint,
        }
        next.set(job.key, {
          ...current,
          status: 'ok',
          attempts: upsertAttempt(current.attempts, completedAttempt),
          image: preview,
          savedPath: response.savedPath,
          attemptId: response.attemptId,
          version: actualVersion,
          pendingVersion: undefined,
          activeRequestId: undefined,
          errorMsg: response.attemptWarning,
          lastInputFingerprint: job.inputFingerprint,
          progress: generationTaskProgress(current.progress, 'ok'),
        })
      })
      setSelectedAttemptVersions(previous => new Map(previous).set(job.key, actualVersion))
    } catch (error: any) {
      if (activeProjectRef.current !== job.projectRoot) return
      const message = error?.name === 'AbortError'
        ? '任务已停止，已保留此前成功版本'
        : error?.message || '生成失败'
      const failedStatus: TaskStatus = error?.name === 'AbortError' ? 'cancelled' : 'error'
      const completedAt = new Date().toISOString()
      commitTasks(next => {
        const current = next.get(job.key)
        if (!current || current.activeRequestId !== job.requestId) return
        const failedAttempt: TaskAttemptState = {
          requestId: job.requestId,
          batchId: job.batchId,
          version: job.version,
          status: failedStatus,
          createdAt: job.createdAt,
          completedAt,
          errorMsg: message,
          inputFingerprint: job.inputFingerprint,
        }
        next.set(job.key, {
          ...current,
          status: failedStatus,
          attempts: upsertAttempt(current.attempts, failedAttempt),
          activeRequestId: undefined,
          pendingVersion: undefined,
          errorMsg: message,
          progress: generationTaskProgress(current.progress, failedStatus, message),
        })
      })
    } finally {
      const current = tasksRef.current.get(job.key)
      if (!current?.activeRequestId || current.activeRequestId === job.requestId) {
        activeJobKeysRef.current.delete(job.key)
        setQueueRevision(revision => revision + 1)
      }
    }
  }

  const startQueueWorkers = () => {
    if (workerPoolRef.current || pendingJobsRef.current.length === 0 || generationApiKeys.length === 0) return
    const controller = new AbortController()
    abortRef.current = controller
    setGenerating(true)
    const keys = [...generationApiKeys]
    const pool = Promise.all(keys.map(async apiKey => {
      while (!controller.signal.aborted) {
        const job = pendingJobsRef.current.shift()
        if (!job) break
        await runGenerationJob(job, apiKey, controller.signal)
      }
    })).then(() => undefined)
    workerPoolRef.current = pool
    void pool.finally(() => {
      if (workerPoolRef.current !== pool) return
      workerPoolRef.current = null
      if (abortRef.current === controller) abortRef.current = null
      if (pendingJobsRef.current.length > 0) {
        startQueueWorkers()
      } else {
        setGenerating(false)
      }
    })
  }

  const enqueueGenerationJobs = (jobs: GenerationJob[]) => {
    const accepted = jobs.filter(job => {
      if (activeJobKeysRef.current.has(job.key)) return false
      activeJobKeysRef.current.add(job.key)
      return true
    })
    if (!accepted.length) return 0
    pendingJobsRef.current.push(...accepted)
    commitTasks(next => {
      for (const job of accepted) {
        const previous = next.get(job.key)
        const queuedAttempt: TaskAttemptState = {
          requestId: job.requestId,
          batchId: job.batchId,
          version: job.version,
          status: 'queued',
          createdAt: job.createdAt,
          inputFingerprint: job.inputFingerprint,
        }
        next.set(job.key, {
          ...previous,
          status: 'queued',
          attempts: upsertAttempt(previous?.attempts || [], queuedAttempt),
          activeRequestId: job.requestId,
          pendingVersion: job.version,
          batchId: job.batchId,
          errorMsg: undefined,
          progress: generationTaskProgress(previous?.progress, 'queued'),
        })
      }
    })
    startQueueWorkers()
    return accepted.length
  }

  const retryPair = (scene: string, product: string) => {
    if (!generationApiKeys.length) return
    const key = `${scene}|${product}`
    const task = tasksRef.current.get(key)
    if (activeJobKeysRef.current.has(key)) return
    const orderedAttempts = task?.attempts.slice().sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ) || []
    const latestAttempt = orderedAttempts[orderedAttempts.length - 1]
    const version = latestAttempt && (latestAttempt.status === 'error' || latestAttempt.status === 'cancelled')
      ? latestAttempt.version
      : Math.max(1, maxAttemptVersion(task))
    const batchId = `retry-${createRequestId()}`
    enqueueGenerationJobs([buildGenerationJob(
      scene,
      product,
      version,
      batchId,
      redoPrompt.get(key) || prompts.get(scene) || defaultPrompt || undefined,
    )])
  }

  const redoPair = (scene: string, product: string) => {
    const key = `${scene}|${product}`
    if (activeJobKeysRef.current.has(key) || !generationApiKeys.length) return
    const version = Math.max(1, maxAttemptVersion(tasksRef.current.get(key)) + 1)
    const batchId = `redo-${createRequestId()}`
    enqueueGenerationJobs([buildGenerationJob(
      scene,
      product,
      version,
      batchId,
      redoPrompt.get(key) || prompts.get(scene) || defaultPrompt || undefined,
    )])
  }

  const handleGenerate = async () => {
    if (enqueuingRef.current || mapping.size === 0 || generationApiKeys.length === 0) return
    enqueuingRef.current = true
    setEnqueuing(true)
    try {
      const allPairs: { scene: string; product: string }[] = []
      for (const [scene, prodSet] of mapping) {
        if (!checkedScenes.has(scene)) continue
        for (const product of prodSet) allPairs.push({ scene, product })
      }

      const confirmationScenes = new Map<string, string[]>()
      for (const [scene, prodSet] of mapping) {
        if (!checkedScenes.has(scene) || !skillScenes.has(scene)) continue
        const selected = [...prodSet]
        const requiresConfirmation = selected.some(product => !skillMatches.some(match =>
          match.scenePath === scene && match.productPath === product && match.status === 'auto'))
        if (requiresConfirmation) confirmationScenes.set(scene, selected)
      }
      if (confirmationScenes.size) {
        setScanError('')
        try {
          await Promise.all([...confirmationScenes].map(async ([scene, selected]) => {
            const timer = referenceTrainingTimersRef.current.get(scene)
            if (timer) {
              window.clearTimeout(timer)
              referenceTrainingTimersRef.current.delete(scene)
            }
            await persistReferenceSelection(scene, selected)
          }))
        } catch (error: any) {
          setScanError(error?.message || '待复核参考图保存失败，已阻止加入队列')
          return
        }
      }

      const batchId = `batch-${createRequestId()}`
      const jobs = allPairs.flatMap(pair => {
        const key = `${pair.scene}|${pair.product}`
        if (activeJobKeysRef.current.has(key)) return []
        const task = tasksRef.current.get(key)
        const fingerprint = inputFingerprintFor(pair.scene, pair.product)
        const lastSuccess = task ? latestSuccessfulAttempt(task) : undefined
        if (lastSuccess && (!task?.lastInputFingerprint || task.lastInputFingerprint === fingerprint)) return []
        const orderedAttempts = task?.attempts.slice().sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt),
        ) || []
        const latestAttempt = orderedAttempts[orderedAttempts.length - 1]
        const version = lastSuccess
          ? maxAttemptVersion(task) + 1
          : latestAttempt && (latestAttempt.status === 'error' || latestAttempt.status === 'cancelled')
            ? latestAttempt.version
            : 1
        return [buildGenerationJob(pair.scene, pair.product, version, batchId)]
      })
      enqueueGenerationJobs(jobs)
    } finally {
      enqueuingRef.current = false
      setEnqueuing(false)
    }
  }

  const handleStop = () => {
    cancelActiveGeneration()
  }

  const handleDownload = useCallback((image: string | undefined, savedPath: string | undefined, label: string) => {
    if (!image && !savedPath) return
    const a = document.createElement('a')
    a.href = savedPath ? getResultDownloadUrl(savedPath) : image!
    a.download = label + '.png'
    a.click()
  }, [])

  const sendToVerification = (
    scene: string,
    product: string,
    task: TaskState,
    selectedAttempt?: TaskAttemptState,
  ) => {
    const attempt = selectedAttempt || latestSuccessfulAttempt(task)
    if (!attempt?.savedPath && !attempt?.image) return
    if (!attempt.attemptId || attempt.integrity === 'unchecked') return
    const version = attempt.version || task.version || 1
    const id = attempt.attemptId
      ? `generation|${attempt.attemptId}`
      : `${scene}|${product}|v${version}`
    const nextTasks = new Map(tasksRef.current)
    const current = nextTasks.get(`${scene}|${product}`)
    if (current) {
      nextTasks.set(`${scene}|${product}`, {
        ...current,
        progress: updateWorkflowProgress(current.progress, {
          status: 'completed',
          stage: 'handoff',
          stageLabel: '已确认并发送核验',
          percent: 100,
        }),
      })
      tasksRef.current = nextTasks
      setTasks(nextTasks)
    }
    const queuedAt = new Date().toISOString()
    onSendToVerification({
      id,
      attemptId: attempt.attemptId,
      scenePath: scene,
      productPath: product,
      supportingProductPaths: supportingProductPathsFor(scene, product),
      outputImage: attempt.savedPath ? undefined : attempt.image,
      outputPreviewUrl: attempt.savedPath ? getThumbnailUrl(attempt.savedPath, 720) : attempt.image,
      scenePreviewUrl: getThumbnailUrl(scene, 360),
      productPreviewUrl: getThumbnailUrl(product, 240),
      savedPath: attempt.savedPath,
      version,
      queuedAt,
      progress: createVerificationProgress(queuedAt),
    })
  }

  let totalPairs = 0
  let enqueueableCount = 0
  let okCount = 0
  let errCount = 0
  let runningCount = 0
  let queuedCount = 0
  let cancelledCount = 0
  for (const [scene, prodSet] of mapping) {
    if (!checkedScenes.has(scene)) continue
    totalPairs += prodSet.size
    for (const product of prodSet) {
      const key = `${scene}|${product}`
      if (activeJobKeysRef.current.has(key)) continue
      const task = tasks.get(key)
      const lastSuccess = task ? latestSuccessfulAttempt(task) : undefined
      if (
        !lastSuccess
        || Boolean(task?.lastInputFingerprint && task.lastInputFingerprint !== inputFingerprintFor(scene, product))
      ) {
        enqueueableCount += 1
      }
    }
  }
  for (const [, v] of tasks) {
    if (latestSuccessfulAttempt(v)) okCount++
    if (v.status === 'error') errCount++
    else if (v.status === 'running') runningCount++
    else if (v.status === 'queued') queuedCount++
    else if (v.status === 'cancelled') cancelledCount++
  }
  const taskTotalCount = tasks.size
  const settledTaskCount = [...tasks.values()].filter(task =>
    task.status === 'ok' || task.status === 'error' || task.status === 'cancelled',
  ).length
  const analyzedSceneCount = scenes.filter(scene => sceneAngles.has(scene)).length
  const selectedPendingAngles = scenes.filter(scene => checkedScenes.has(scene) && !sceneAngles.has(scene)).length
  const analyzedProductCount = products.filter(product => productAngles.has(product)).length
  const pendingProductAngles = products.length - analyzedProductCount

  const groupByProduct = useMemo(() => {
    const index = new Map<string, string>()
    for (const group of productGroups) for (const image of group.images) index.set(image, group.name)
    return index
  }, [productGroups])

  const skillMatchesByScene = useMemo(() => {
    const index = new Map<string, SkillMatchResult[]>()
    for (const match of skillMatches) {
      const list = index.get(match.scenePath) || []
      list.push(match)
      index.set(match.scenePath, list)
    }
    return index
  }, [skillMatches])

  const angleMatchesByScene = useMemo(() => {
    const index = new Map<string, AngleMatch[]>()
    for (const match of angleMatches) {
      const list = index.get(match.scenePath) || []
      list.push(match)
      index.set(match.scenePath, list)
    }
    return index
  }, [angleMatches])

  const sceneStatusByPath = useMemo(() => {
    const index = new Map<string, SceneFilter>()
    for (const scene of scenes) {
      const matches = skillMatchesByScene.get(scene) || []
      const angle = sceneAngles.get(scene)
      if (matches.some(match => match.status === 'unmatched')) index.set(scene, 'unmatched')
      else if (matches.some(match => match.mirrored)) index.set(scene, 'mirrored')
      else if (matches.some(match => match.status === 'review') || (angle && angle.confidence < 0.7)) index.set(scene, 'review')
      else index.set(scene, 'auto')
    }
    return index
  }, [scenes, sceneAngles, skillMatchesByScene])

  const filterCounts = useMemo(() => ({
    all: scenes.length,
    review: scenes.filter(scene => sceneStatusByPath.get(scene) === 'review').length,
    auto: scenes.filter(scene => sceneStatusByPath.get(scene) === 'auto').length,
    unmatched: scenes.filter(scene => sceneStatusByPath.get(scene) === 'unmatched').length,
    mirrored: scenes.filter(scene => sceneStatusByPath.get(scene) === 'mirrored').length,
  }), [scenes, sceneStatusByPath])

  const filteredScenes = useMemo(() => sceneFilter === 'all'
    ? scenes
    : scenes.filter(scene => sceneStatusByPath.get(scene) === sceneFilter),
  [sceneFilter, scenes, sceneStatusByPath])

  useEffect(() => {
    if (filteredScenes.length > 0 && (!activeScene || !filteredScenes.includes(activeScene))) {
      setActiveScene(filteredScenes[0])
    }
  }, [activeScene, filteredScenes])

  const activeSelected = activeScene ? (mapping.get(activeScene) || new Set<string>()) : new Set<string>()
  const activeAngle = activeScene ? sceneAngles.get(activeScene) : undefined
  const activeSkillScene = activeScene ? skillScenes.get(activeScene) : undefined
  const activeInlineTrainingState = activeScene ? inlineTrainingStates.get(activeScene) : undefined
  const activeSkillMatches = activeScene ? (skillMatchesByScene.get(activeScene) || []) : []
  const activeAngleMatches = activeScene ? (angleMatchesByScene.get(activeScene) || []) : []
  const recommendedProducts = useMemo(() => new Set(activeSkillMatches.flatMap(match => [
    ...(match.productPath ? [match.productPath] : []),
    ...match.supportingReferences.flatMap(reference => reference.productPath ? [reference.productPath] : []),
  ])), [activeSkillMatches])

  const allProductPaths = useMemo(() => productGroups.length > 0
    ? productGroups.flatMap(group => group.images)
    : products,
  [productGroups, products])

  const candidateProducts = useMemo(() => {
    const query = productSearch.trim().toLocaleLowerCase()
    return allProductPaths
      .filter(product => !filterGroup || groupByProduct.get(product) === filterGroup)
      .filter(product => !query || `${shortName(product)} ${groupByProduct.get(product) || ''}`.toLocaleLowerCase().includes(query))
      .filter(product => angleFilter === 'all' || productAngles.get(product)?.angle === angleFilter)
      .map((product, originalIndex) => ({
        product,
        originalIndex,
        score: activeSelected.has(product) ? 0 : recommendedProducts.has(product) ? 1 : 2,
      }))
      .sort((a, b) => a.score - b.score || a.originalIndex - b.originalIndex)
      .map(item => item.product)
  }, [activeSelected, allProductPaths, angleFilter, filterGroup, groupByProduct, productAngles, productSearch, recommendedProducts])

  const candidateVirtualizer = useVirtualizer({
    count: Math.ceil(candidateProducts.length / 2),
    getScrollElement: () => candidateScrollRef.current,
    estimateSize: () => 194,
    overscan: 3,
  })
  const virtualRows = candidateVirtualizer.getVirtualItems()
  const virtualRowKey = virtualRows.map(row => row.index).join(',')

  useEffect(() => {
    const visible = virtualRows.flatMap(row => candidateProducts.slice(row.index * 2, row.index * 2 + 2))
    setProductThumbs(previous => {
      const missing = visible.filter(product => !previous.has(product))
      if (!missing.length) return previous
      const next = new Map(previous)
      for (const product of missing) next.set(product, getThumbnailUrl(product, 180))
      return next
    })
  }, [candidateProducts, virtualRowKey])

  useEffect(() => {
    if (!previewProduct) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewProduct(null)
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const index = candidateProducts.indexOf(previewProduct)
      const nextIndex = event.key === 'ArrowLeft' ? index - 1 : index + 1
      if (nextIndex >= 0 && nextIndex < candidateProducts.length) setPreviewProduct(candidateProducts[nextIndex])
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [candidateProducts, previewProduct])

  useGSAP(() => {
    if (!scenes.length) return
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo('.scene-inspector-content', { autoAlpha: 0.5, y: 8 }, {
        autoAlpha: 1,
        y: 0,
        duration: 0.22,
        ease: 'power2.out',
        clearProps: 'transform,opacity,visibility',
      })
    })
    return () => media.revert()
  }, { scope: workspaceRef, dependencies: [activeScene], revertOnUpdate: true })

  useGSAP(() => {
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo('.candidate-card', { autoAlpha: 0, y: 6 }, {
        autoAlpha: 1,
        y: 0,
        duration: 0.18,
        stagger: 0.025,
        ease: 'power1.out',
        clearProps: 'transform,opacity,visibility',
      })
    })
    return () => media.revert()
  }, { scope: workspaceRef, dependencies: [activeScene, filterGroup, angleFilter, productSearch], revertOnUpdate: true })

  const workflowStage = scenes.length === 0 ? 0
    : angleAnalyzing || productAngleAnalyzing ? 1
      : generating ? 3
        : okCount > 0 || errCount > 0 ? 4
          : 2
  const workflowSteps = ['导入项目', '识别匹配', '人工复核', '批量生成', '查看结果']
  const generationProgress = taskTotalCount > 0
    ? Math.round((settledTaskCount / taskTotalCount) * 100)
    : 0

  return (
    <div className="folder-workbench" ref={workspaceRef}>
      <nav className="workflow-rail" aria-label="工作流程">
        {workflowSteps.map((step, index) => (
          <div key={step} className={`workflow-item ${index === workflowStage ? 'is-active' : ''} ${index < workflowStage ? 'is-complete' : ''}`}>
            <span className="workflow-icon" aria-hidden="true">{index < workflowStage ? <Check size={14} weight="bold" /> : index + 1}</span>
            <span>{step}</span>
          </div>
        ))}
      </nav>

      <section className={`project-loader ${scenes.length > 0 ? 'is-compact' : ''}`}>
        <div className="project-loader-copy">
          <FolderOpen size={22} weight="bold" aria-hidden="true" />
          <div><strong>{scenes.length > 0 ? '当前项目' : '导入图片项目'}</strong><small>选择项目文件夹，然后使用 Codex 模型与已训练 Skill 完成角度识别和素材匹配。</small></div>
        </div>
        <div className="folder-input-row">
          <label className="sr-only" htmlFor="folder-path">项目文件夹路径</label>
          <input id="folder-path" className="folder-input" placeholder="项目路径，包含 scenes 和 products 文件夹"
            value={folderPath} onChange={(event) => setFolderPath(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && handleScan()} />
          <button className="btn-scan" onClick={handleScan} disabled={scanning || !folderPath.trim()}>
            {scanning ? <span className="spinner" /> : <MagnifyingGlass size={17} weight="bold" aria-hidden="true" />}
            {scanning ? '扫描中' : '扫描项目'}
          </button>
          <button className="btn-skill" onClick={handleCodexSkillRecognition} disabled={skillLoading || scanning || !folderPath.trim() || !runtimeReady}>
            {skillLoading ? <span className="spinner" /> : <Robot size={18} weight="bold" aria-hidden="true" />}
            {skillLoading ? 'Codex 识别中' : '角度识别'}
            <span className="zero-token">Codex + Skill</span>
          </button>
        </div>
      </section>

      {scanError && <div className="error-banner"><WarningCircle size={18} weight="fill" aria-hidden="true" />{scanError}</div>}
      {angleError && <div className="error-banner"><WarningCircle size={18} weight="fill" aria-hidden="true" />{angleError}</div>}
      {nanoBananaApiKeys.length + image2ApiKeys.length === 0 && (
        <div className="info-banner">
          <ShieldCheck size={18} weight="bold" aria-hidden="true" />
          {skillSummary ? `角度结果来自 ${runtime.model} 与 ${runtime.skillId}；API Key 只用于后续图片生成。` : '角度识别使用上方后台模型配置；页面 API Key 只用于图片生成和旧版视觉接口。'}
        </div>
      )}

      {skillSummary && (
        <section className="skill-summary" aria-label="Skill 成果摘要">
          <div className="skill-summary-title">
            <CheckCircle size={22} weight="fill" aria-hidden="true" />
            <div><strong>Codex 角度识别与 Skill 匹配已完成</strong><small>训练规则已应用于方向、脚垫、可见性、多椅场景与安全拒绝。</small></div>
          </div>
          <div className="skill-metrics">
            <span><b>{skillSummary.sceneCount}</b><small>场景</small></span>
            <span><b>{skillSummary.autoCount}</b><small>自动匹配</small></span>
            <span className={skillSummary.reviewCount > 0 ? 'needs-attention' : ''}><b>{skillSummary.reviewCount}</b><small>待复核</small></span>
            <span><b>{skillSummary.multiViewSceneCount}</b><small>多视角</small></span>
            <span className="token-metric"><b>{skillSummary.externalApiCalls}</b><small>Codex 调用</small></span>
          </div>
        </section>
      )}

      <section className="prompt-composer" aria-label="生成提示词">
        <div className="prompt-composer-heading">
          <span className="prompt-composer-icon" aria-hidden="true"><MagicWand size={20} weight="bold" /></span>
          <div>
            <label htmlFor="global-prompt">生成提示词</label>
            <small>应用到所有已选场景；某张场景填写“当前场景附加要求”后，将优先使用该场景的内容。</small>
          </div>
        </div>
        <div className="prompt-composer-field">
          <div className="generation-options-row">
            <div className="ratio-picker" role="group" aria-label="图像模型">
              <span className="ratio-picker-label">图像模型</span>
              <div className="ratio-preset-list">
                <button type="button" className={`ratio-preset model-preset ${imageModel === 'nano-banana-2' ? 'is-active' : ''}`}
                  aria-pressed={imageModel === 'nano-banana-2'} disabled={generating} onClick={() => setImageModel('nano-banana-2')}>
                  Nano Banana 2
                </button>
                <button type="button" className={`ratio-preset model-preset ${imageModel === 'gpt-image-2' ? 'is-active' : ''}`}
                  aria-pressed={imageModel === 'gpt-image-2'} disabled={generating} onClick={() => setImageModel('gpt-image-2')}>
                  Image 2
                </button>
              </div>
            </div>
            <div className="ratio-picker" role="group" aria-label="图像比例">
              <span className="ratio-picker-label">图像比例</span>
              <div className="ratio-preset-list">
                {PRIMARY_ASPECT_RATIO_OPTIONS.map(ratio => (
                  <button key={ratio} type="button"
                    className={`ratio-preset ${aspectRatio === ratio ? 'is-active' : ''}`}
                    aria-pressed={aspectRatio === ratio}
                    aria-label={ratio === 'auto' ? 'Auto，跟随图1原图比例' : `固定比例 ${ratio}`}
                    title={ratio === 'auto' ? '跟随图1原图比例' : `固定为 ${ratio}`}
                    onClick={() => setAspectRatio(ratio)}>
                    {ratio === 'auto' ? 'Auto' : ratio}
                  </button>
                ))}
                <label className={`ratio-more ${MORE_ASPECT_RATIO_OPTIONS.includes(aspectRatio) ? 'is-active' : ''}`}>
                  <span>{MORE_ASPECT_RATIO_OPTIONS.includes(aspectRatio) ? aspectRatio : '更多'}</span>
                  <CaretDown size={13} weight="bold" aria-hidden="true" />
                  <select aria-label="更多图像比例"
                    value={MORE_ASPECT_RATIO_OPTIONS.includes(aspectRatio) ? aspectRatio : ''}
                    onChange={(event) => setAspectRatio(event.target.value as ImageAspectRatio)}>
                    <option value="" disabled>更多比例</option>
                    {MORE_ASPECT_RATIO_OPTIONS.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}
                  </select>
                </label>
              </div>
            </div>
            <div className="ratio-picker" role="group" aria-label="输出分辨率">
              <span className="ratio-picker-label">分辨率</span>
              <div className="ratio-preset-list">
                {(['1K', '2K', '4K'] as ImageResolution[]).map(resolution => (
                  <button key={resolution} type="button" className={`ratio-preset resolution-preset ${imageResolution === resolution ? 'is-active' : ''}`}
                    aria-pressed={imageResolution === resolution} onClick={() => setImageResolution(resolution)}>
                    {resolution}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <textarea id="global-prompt" className="global-prompt-input" rows={3}
            placeholder="例如：保持人物、构图和光影不变，仅替换椅子颜色与材质；保留品牌 Logo、脚托和五金结构。"
            value={defaultPrompt} onChange={(event) => setDefaultPrompt(event.target.value)} />
          <div className="prompt-composer-meta">
            <span>{scenes.length > 0 ? `将应用到 ${checkedScenes.size} 个已选场景` : '可先填写，导入项目后自动应用'}</span>
            <span>{defaultPrompt.trim() ? '已填写' : '可选'}</span>
          </div>
        </div>
      </section>

      {scenes.length > 0 ? (
        <>
          <section className="review-toolbar">
            <div className="scene-filter-tabs" role="tablist" aria-label="场景状态筛选">
              {([
                ['all', '全部'],
                ['review', '待复核'],
                ['unmatched', '未匹配'],
                ['mirrored', '镜像风险'],
                ['auto', '已匹配'],
              ] as const).map(([value, label]) => (
                <button key={value} role="tab" aria-selected={sceneFilter === value}
                  className={sceneFilter === value ? 'active' : ''} onClick={() => setSceneFilter(value)}>
                  {label}<span>{filterCounts[value]}</span>
                </button>
              ))}
            </div>
            <div className="review-toolbar-actions">
              <details className="tool-disclosure">
                <summary><Robot size={17} weight="bold" aria-hidden="true" />识别工具<CaretDown size={15} weight="bold" aria-hidden="true" /></summary>
                <div className="tool-popover">
                  <div className="tool-popover-copy"><strong>重新调用模型</strong><small>仅点击下方按钮时调用 API。已识别 {analyzedSceneCount}/{scenes.length} 张。</small></div>
                  {angleSummary && <p className="angle-summary">{angleSummary}</p>}
                  <button type="button" className={`btn-angle ${angleAnalyzing ? 'is-running' : ''}`}
                    disabled={!angleAnalyzing && (selectedPendingAngles === 0 || nanoBananaApiKeys.length === 0)} onClick={handleAnalyzeAngles}>
                    {angleAnalyzing ? <Stop size={16} weight="fill" /> : <Robot size={16} weight="bold" />}
                    {angleAnalyzing ? '停止场景识别' : selectedPendingAngles > 0 ? `识别场景 (${Math.min(selectedPendingAngles, 50)})` : '场景已识别'}
                  </button>
                  <button type="button" className={`btn-angle btn-angle-secondary ${productAngleAnalyzing ? 'is-running' : ''}`}
                    disabled={!productAngleAnalyzing && (analyzedSceneCount === 0 || products.length === 0 || (pendingProductAngles > 0 && nanoBananaApiKeys.length === 0))}
                    onClick={handleAnalyzeProductAngles}>
                    {productAngleAnalyzing ? <Stop size={16} weight="fill" /> : <ArrowsClockwise size={16} weight="bold" />}
                    {productAngleAnalyzing ? '停止素材识别' : pendingProductAngles > 0 ? `识别素材并匹配 (${Math.min(pendingProductAngles, 50)})` : `重新匹配素材 (${analyzedProductCount}/${products.length})`}
                  </button>
                </div>
              </details>
            </div>
          </section>

          <section className="review-workspace">
            <aside className="scene-navigator" aria-label="场景列表">
              <div className="panel-heading">
                <div><strong>场景</strong><small>{filteredScenes.length} / {scenes.length}</small></div>
                <label className="select-all-control">
                  <input type="checkbox" checked={checkedScenes.size === scenes.length && scenes.length > 0}
                    onChange={() => checkedScenes.size === scenes.length ? deselectAllScenes() : selectAllScenes()} />
                  全选
                </label>
              </div>
              <div className="scene-list">
                {filteredScenes.map(scene => {
                  const angle = sceneAngles.get(scene)
                  const status = sceneStatusByPath.get(scene) || 'review'
                  return (
                    <div key={scene} className={`scene-list-row ${activeScene === scene ? 'is-active' : ''} ${!checkedScenes.has(scene) ? 'is-disabled' : ''}`}>
                      <input type="checkbox" aria-label={`选择 ${shortName(scene)}`} checked={checkedScenes.has(scene)} onChange={() => toggleSceneChecked(scene)} />
                      <button type="button" onClick={() => setActiveScene(scene)}>
                        <span className="scene-list-thumb">
                          {sceneThumbs.get(scene) ? <img src={sceneThumbs.get(scene)} alt="" loading="lazy" decoding="async" /> : <span className="image-skeleton" />}
                        </span>
                        <span className="scene-list-copy">
                          <strong title={shortName(scene)}>{shortName(scene)}</strong>
                          <small>{angle ? `${ANGLE_LABELS[angle.angle]} ${Math.round(angle.confidence * 100)}%` : '角度待识别'}</small>
                        </span>
                        <span className={`scene-status status-${status}`}>{status === 'auto' ? '已匹配' : status === 'review' ? '复核' : status === 'mirrored' ? '镜像' : '缺失'}</span>
                      </button>
                    </div>
                  )
                })}
                {filteredScenes.length === 0 && <div className="list-empty"><Funnel size={24} weight="bold" /><span>当前筛选没有场景</span></div>}
              </div>
            </aside>

            <main className="scene-inspector">
              {activeScene && (
                <div className="scene-inspector-content">
                  <div className="panel-heading inspector-heading">
                    <div><strong title={shortName(activeScene)}>{shortName(activeScene)}</strong><small>场景预览与识别依据</small></div>
                    <label className="scene-enable-control"><input type="checkbox" checked={checkedScenes.has(activeScene)} onChange={() => toggleSceneChecked(activeScene)} />参与生成</label>
                  </div>
                  <figure className="scene-preview">
                    {sceneThumbs.get(activeScene) ? <img src={sceneThumbs.get(activeScene)} alt={`${shortName(activeScene)} 场景预览`} decoding="async" /> : <span className="image-skeleton" />}
                  </figure>
                  <div className="recognition-facts">
                    <div><span>观察角度</span><strong>{activeAngle ? ANGLE_LABELS[activeAngle.angle] : '待识别'}</strong><small>{activeAngle?.azimuth != null ? `${Math.round(activeAngle.azimuth)}°` : '方位未知'}</small></div>
                    <div><span>脚垫状态</span><strong>{activeSkillScene ? FOOTREST_LABELS[activeSkillScene.footrest.state] : '待核验'}</strong><small>{activeSkillScene ? `${Math.round(activeSkillScene.footrest.confidence * 100)}% 置信度` : '暂无 Skill 数据'}</small></div>
                    <div><span>场景结构</span><strong>{activeSkillScene?.sceneMode === 'multi_same_model' ? '同款多椅子' : activeSkillScene?.chairCount && activeSkillScene.chairCount > 1 ? '多椅子' : '单椅子'}</strong><small>{activeSkillMatches.some(match => match.referenceMode === 'multi_view') || activeSkillScene?.sceneMode === 'multi_same_model' ? '保留多个观察角度' : '单一主视角'}</small></div>
                  </div>
                  <div className="inline-review-bar">
                    <button
                      type="button"
                      className="inline-angle-button"
                      disabled={!activeSkillScene || activeInlineTrainingState?.status === 'saving'}
                      onClick={() => setInlineReviewDraft(activeSkillScene ? createInlineReview(activeSkillScene) : null)}
                    >
                      人工修正角度
                    </button>
                    {activeInlineTrainingState && (
                      <span className={`inline-training-state ${activeInlineTrainingState.status}`}>
                        {activeInlineTrainingState.status === 'saving'
                          ? '后台学习中，可继续套版'
                          : activeInlineTrainingState.status === 'saved'
                            ? '已写入项目数据库与 Skill'
                            : `保存失败：${activeInlineTrainingState.error}`}
                      </span>
                    )}
                  </div>
                  {inlineReviewDraft?.scenePath === activeScene && (
                    <section className="inline-review-editor" aria-label="人工修正角度">
                      <label>
                        <span>可判断程度</span>
                        <select
                          value={inlineReviewDraft.angleObservability ?? 'none'}
                          onChange={event => setInlineReviewDraft(previous => previous ? {
                            ...previous,
                            angleObservability: event.target.value as AngleObservability,
                          } : previous)}
                        >
                          <option value="exact">可判断准确角度</option>
                          <option value="coarse">只能判断大方向</option>
                          <option value="none">无法判断</option>
                        </select>
                      </label>
                      {inlineReviewDraft.angleObservability === 'exact' && inlineReviewDraft.sceneMode === 'single' && (
                        <>
                          <label>
                            <span>标准视角</span>
                            <select
                              value={ANGLE_PRESETS.some(item => item.azimuth === inlineReviewDraft.azimuth) ? String(inlineReviewDraft.azimuth) : ''}
                              onChange={event => setInlineReviewDraft(previous => previous ? {
                                ...previous,
                                azimuth: Number(event.target.value),
                              } : previous)}
                            >
                              <option value="" disabled>自定义角度</option>
                              {ANGLE_PRESETS.map(item => <option key={item.angle} value={item.azimuth}>{ANGLE_LABELS[item.angle]} · {item.azimuth}°</option>)}
                            </select>
                          </label>
                          <label>
                            <span>精确方位角</span>
                            <input
                              type="number"
                              min={0}
                              max={359}
                              step={1}
                              value={inlineReviewDraft.azimuth ?? ''}
                              onChange={event => setInlineReviewDraft(previous => previous ? {
                                ...previous,
                                azimuth: event.target.value === '' ? null : Number(event.target.value),
                              } : previous)}
                            />
                          </label>
                        </>
                      )}
                      {inlineReviewDraft.angleObservability === 'coarse' && (
                        <label>
                          <span>大方向</span>
                          <select
                            value={inlineReviewDraft.coarseDirection ?? 'unknown'}
                            onChange={event => setInlineReviewDraft(previous => previous ? {
                              ...previous,
                              coarseDirection: event.target.value as CoarseDirection,
                            } : previous)}
                          >
                            <option value="front">前</option>
                            <option value="right">右</option>
                            <option value="back">后</option>
                            <option value="left">左</option>
                            <option value="unknown">未知</option>
                          </select>
                        </label>
                      )}
                      <label className="inline-review-note">
                        <span>判断备注（可选）</span>
                        <input
                          value={inlineReviewDraft.reviewerNote ?? ''}
                          placeholder="例如：以靠背正面和右扶手透视为依据"
                          onChange={event => setInlineReviewDraft(previous => previous ? { ...previous, reviewerNote: event.target.value } : previous)}
                        />
                      </label>
                      <div className="inline-review-actions">
                        <button type="button" className="secondary-button" onClick={() => setInlineReviewDraft(null)}>取消</button>
                        <button
                          type="button"
                          className="primary-button"
                          disabled={inlineReviewDraft.angleObservability === 'exact' && inlineReviewDraft.sceneMode === 'single' && inlineReviewDraft.azimuth == null}
                          onClick={applyInlineReview}
                        >
                          应用并后台学习
                        </button>
                      </div>
                    </section>
                  )}
                  {(activeSkillScene?.decisiveCue || activeAngle?.reason) && (
                    <div className="recognition-reason"><ShieldCheck size={17} weight="bold" aria-hidden="true" /><p>{activeSkillScene?.decisiveCue || activeAngle?.reason}</p></div>
                  )}

                  <div className="selection-section">
                    <div className="section-heading"><div><strong>已选参考素材</strong><small>{activeSelected.size} 项</small></div><span>点击右侧候选素材可以添加或移除</span></div>
                    {activeSelected.size > 0 ? (
                      <div className="selected-reference-tray">
                        {[...activeSelected].map(product => {
                          const skillMatch = activeSkillMatches.find(match => match.productPath === product)
                          const angleMatch = activeAngleMatches.find(match => match.productPath === product)
                          const task = tasks.get(`${activeScene}|${product}`)
                          return (
                            <article key={product} className="selected-reference">
                              <button type="button" className="selected-reference-preview" onClick={() => setPreviewProduct(product)} aria-label={`预览 ${shortName(product)}`}>
                                {productThumbs.get(product) ? <img src={productThumbs.get(product)} alt="" loading="lazy" decoding="async" /> : <span className="image-skeleton" />}
                              </button>
                              <div className="selected-reference-copy"><strong title={shortName(product)}>{shortName(product)}</strong><small>{groupByProduct.get(product) || '未分组'}{skillMatch?.referenceMode === 'multi_view' ? '，多视角参考' : ''}</small></div>
                              <span className={`reference-match-state ${skillMatch?.status === 'review' || angleMatch?.status === 'review' ? 'needs-review' : ''}`}>
                                {task?.status === 'running'
                                  ? latestSuccessfulAttempt(task) ? `重做中 · 保留 v${task.version || 1}` : '生成中'
                                  : task?.status === 'queued'
                                    ? latestSuccessfulAttempt(task) ? `已排队 · 保留 v${task.version || 1}` : '已排队'
                                    : task?.status === 'ok'
                                      ? `已完成 v${task.version || 1}`
                                      : task?.status === 'error'
                                        ? latestSuccessfulAttempt(task) ? `重做失败 · 保留 v${task.version || 1}` : '失败'
                                        : skillMatch?.mirrored
                                          ? '镜像复核'
                                          : skillMatch?.status === 'review' || angleMatch?.status === 'review'
                                            ? '待复核'
                                            : '已匹配'}
                              </span>
                              {task?.status === 'error' && <button type="button" className="icon-button" onClick={() => retryPair(activeScene, product)} title={task.errorMsg} aria-label="重试生成"><ArrowsClockwise size={16} weight="bold" /></button>}
                              <button type="button" className="icon-button" onClick={() => toggleProduct(activeScene, product)} aria-label={`移除 ${shortName(product)}`}><X size={16} weight="bold" /></button>
                            </article>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="selection-empty"><ImageSquare size={23} weight="bold" /><span>尚未选择参考素材</span></div>
                    )}
                  </div>

                  <div className="scene-prompt-block">
                    <label htmlFor="scene-prompt">当前场景附加要求</label>
                    <textarea id="scene-prompt" rows={2} placeholder="可选，只覆盖这一张场景图的附加要求。"
                      value={prompts.get(activeScene) || ''} onChange={(event) => setScenePrompt(activeScene, event.target.value)} />
                  </div>
                </div>
              )}
            </main>

            <aside className="candidate-library" aria-label="参考素材库">
              <div className="panel-heading candidate-heading">
                <div><strong>候选素材</strong><small>{candidateProducts.length} / {allProductPaths.length}</small></div>
                <span className="selection-count">已选 {activeSelected.size}</span>
              </div>
              <div className="candidate-search"><MagnifyingGlass size={17} weight="bold" aria-hidden="true" /><input aria-label="搜索素材" placeholder="搜索文件名或颜色" value={productSearch} onChange={(event) => setProductSearch(event.target.value)} />{productSearch && <button type="button" onClick={() => setProductSearch('')} aria-label="清空搜索"><X size={15} weight="bold" /></button>}</div>
              <div className="candidate-filters">
                <label><span>颜色</span><select value={filterGroup} onChange={(event) => setFilterGroup(event.target.value)}><option value="">全部颜色</option>{productGroups.map(group => <option key={group.name} value={group.name}>{group.name} ({group.images.length})</option>)}</select></label>
                <label><span>角度</span><select value={angleFilter} onChange={(event) => setAngleFilter(event.target.value as SceneAngle | 'all')}><option value="all">全部角度</option>{Object.entries(ANGLE_LABELS).filter(([value]) => value !== 'multiple' && value !== 'unknown').map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              </div>
              <div className="candidate-scroll" ref={candidateScrollRef}>
                {candidateProducts.length > 0 ? (
                  <div className="candidate-virtual-canvas" style={{ height: `${candidateVirtualizer.getTotalSize()}px` }}>
                    {virtualRows.map(row => (
                      <div key={row.key} className="candidate-virtual-row" style={{ transform: `translateY(${row.start}px)` }}>
                        {candidateProducts.slice(row.index * 2, row.index * 2 + 2).map(product => {
                          const productAngle = productAngles.get(product)
                          const isSelected = activeSelected.has(product)
                          const isRecommended = recommendedProducts.has(product)
                          return (
                            <div key={product} role="checkbox" aria-checked={isSelected} tabIndex={0}
                              className={`candidate-card ${isSelected ? 'is-selected' : ''} ${isRecommended ? 'is-recommended' : ''}`}
                              onClick={() => activeScene && toggleProduct(activeScene, product)}
                              onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && activeScene) { event.preventDefault(); toggleProduct(activeScene, product) } }}>
                              <div className="candidate-image">
                                {productThumbs.get(product) ? <img src={productThumbs.get(product)} alt={`${shortName(product)} 素材预览`} loading="lazy" decoding="async" /> : <span className="image-skeleton" />}
                                <button type="button" className="preview-button" onClick={(event) => { event.stopPropagation(); setPreviewProduct(product) }} aria-label={`放大预览 ${shortName(product)}`}><Eye size={17} weight="bold" /></button>
                              </div>
                              <div className="candidate-copy"><strong title={shortName(product)}>{shortName(product)}</strong><small>{groupByProduct.get(product) || '未分组'}</small></div>
                              <div className="candidate-meta"><span>{productAngle ? `${ANGLE_LABELS[productAngle.angle]} ${Math.round(productAngle.confidence * 100)}%` : '角度待识别'}</span>{isRecommended && <span className="recommended-label">Skill 推荐</span>}{isSelected && <CheckCircle size={18} weight="fill" aria-label="已选择" />}</div>
                            </div>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                ) : <div className="candidate-empty"><Funnel size={24} weight="bold" /><span>没有符合条件的素材</span><button type="button" onClick={() => { setProductSearch(''); setFilterGroup(''); setAngleFilter('all') }}>清除筛选</button></div>}
              </div>
            </aside>
          </section>

          <section className="generation-dock" aria-label="批量生成控制">
            <div className="generation-summary">
              <div><strong>当前选择 {totalPairs} 组，可加入 {enqueueableCount} 组</strong><small>{imageModel === 'gpt-image-2' ? 'Image 2' : 'Nano Banana 2'} · {imageResolution} · 生成中仍可继续选择并追加下一批</small></div>
              {(generating || taskTotalCount > 0) && <div className="generation-status"><span>已有结果 {okCount}，失败 {errCount}，进行中 {runningCount}，排队 {queuedCount}{cancelledCount ? `，已停止 ${cancelledCount}` : ''}</span><div className="generation-progress"><span style={{ transform: `scaleX(${generationProgress / 100})` }} /></div></div>}
            </div>
            <div className="generation-actions">
              {generationApiKeys.length === 0 && <span className="key-warning"><WarningCircle size={16} weight="fill" />当前模型缺少专属 Key</span>}
              {generating && <button className="btn-cancel" onClick={handleStop}><Stop size={16} weight="fill" />停止</button>}
              <button className="btn-generate" disabled={enqueueableCount === 0 || enqueuing || generationApiKeys.length === 0} onClick={handleGenerate}>
                {enqueuing ? <span className="spinner" /> : <MagicWand size={18} weight="bold" />}
                {enqueuing ? '正在加入队列' : enqueueableCount > 0 ? `加入生成队列 ${enqueueableCount} 组` : generating ? '队列运行中' : '当前选择已生成'}
              </button>
            </div>
          </section>

          {tasks.size > 0 && (
            <section className="generation-task-monitor" aria-label="生成任务进度">
              <div className="generation-task-monitor-heading">
                <div><strong>后台生成队列</strong><small>批次互相独立；新增选择不会改动已经提交的任务快照</small></div>
                <span>{settledTaskCount}/{taskTotalCount} 已结束</span>
              </div>
              <div className="generation-task-monitor-list">
                {[...tasks.entries()].map(([key, task]) => {
                  const [scene, product] = key.split('|')
                  return (
                    <article key={key}>
                      <div className="generation-task-name"><strong>{shortName(scene)}</strong><small>{shortName(product)}</small></div>
                      <TaskProgress progress={task.progress} compact />
                      {(task.status === 'error' || task.status === 'cancelled') && (
                        <button type="button" className="generation-task-retry" disabled={generationApiKeys.length === 0 || activeJobKeysRef.current.has(key)} onClick={() => retryPair(scene, product)}><ArrowsClockwise size={15} weight="bold" />重试</button>
                      )}
                    </article>
                  )
                })}
              </div>
            </section>
          )}
        </>
      ) : !scanError && !scanning && (
        <section className="empty-state">
          <span className="empty-state-icon"><FolderOpen size={30} weight="bold" aria-hidden="true" /></span>
          <h1>从一个图片项目开始</h1>
          <p>项目文件夹需要包含 scenes 和 products 两个子文件夹，也可以直接加载已经核验的 Skill 结果。</p>
          <div className="empty-state-notes"><span><ShieldCheck size={17} weight="bold" />离线成果 0 Token</span><span><ImageSquare size={17} weight="bold" />支持批量场景复核</span></div>
        </section>
      )}

      {(okCount > 0 || errCount > 0) && (
        <section className="results-workspace">
          <div className="results-heading"><div><h2>生成结果</h2><p>对照原场景查看结果，只重新处理需要调整的组合。</p></div><span>{okCount} 成功，{errCount} 失败</span></div>
          <div className="results-grid">
            {[...tasks.entries()].filter(([, task]) => Boolean(latestSuccessfulAttempt(task))).map(([key, task]) => {
              const [scene, product] = key.split('|')
              const attempts = successfulAttempts(task)
                .slice()
                .sort((left, right) => left.version - right.version || left.createdAt.localeCompare(right.createdAt))
              const selectedVersion = selectedAttemptVersions.get(key)
              const displayedAttempt = attempts.find(attempt => attempt.version === selectedVersion)
                || attempts[attempts.length - 1]
              const isRedoing = task.status === 'running' || task.status === 'queued'
              const verificationId = displayedAttempt.attemptId
                ? `generation|${displayedAttempt.attemptId}`
                : `${scene}|${product}|v${displayedAttempt.version}`
              const sentToVerification = queuedVerificationIds.has(verificationId)
              const verificationReady = Boolean(displayedAttempt.attemptId)
                && displayedAttempt.integrity !== 'unchecked'
              const resultPreview = displayedAttempt.savedPath
                ? getThumbnailUrl(displayedAttempt.savedPath, 640)
                : displayedAttempt.image
              return (
                <article key={key} className="batch-result-card">
                  <div className="result-compare">
                    <figure><figcaption>原场景</figcaption>{sceneThumbs.get(scene) ? <ThumbnailImage src={sceneThumbs.get(scene)!} alt={`${shortName(scene)} 原场景`} /> : <span className="image-skeleton" />}</figure>
                    <figure><figcaption>生成结果 · v{displayedAttempt.version}</figcaption>{resultPreview ? <ThumbnailImage src={resultPreview} alt={`${shortName(scene)} 生成结果`} /> : <span className="image-skeleton" />}</figure>
                  </div>
                  {attempts.length > 1 && (
                    <div className="result-version-strip" aria-label="生成版本">
                      {attempts.map(attempt => (
                        <button
                          type="button"
                          key={attempt.requestId}
                          className={attempt.version === displayedAttempt.version ? 'is-active' : ''}
                          onClick={() => setSelectedAttemptVersions(previous => new Map(previous).set(key, attempt.version))}
                        >
                          v{attempt.version}
                        </button>
                      ))}
                    </div>
                  )}
                  {task.status === 'error' && <div className="result-retained-warning"><WarningCircle size={15} weight="fill" />最新重做失败，当前继续显示已落盘的 v{displayedAttempt.version}</div>}
                  {isRedoing && <div className="result-retained-warning is-running"><ArrowsClockwise size={15} weight="bold" />新版本{task.status === 'queued' ? '已排队' : '生成中'}，旧版本保持可用</div>}
                  {displayedAttempt.integrity === 'unchecked' && <div className="result-retained-warning is-running"><ArrowsClockwise size={15} weight="bold" />正在核对落盘文件完整性，缩略图可先查看</div>}
                  <div className="batch-result-meta">
                    <div><strong>{shortName(scene)}</strong><small>{shortName(product)}，版本 {displayedAttempt.version}</small>{displayedAttempt.savedPath && <small title={displayedAttempt.savedPath}>{displayedAttempt.savedPath}</small>}</div>
                    <div className="batch-result-actions">
                      <button className="btn-download" onClick={() => handleDownload(displayedAttempt.image, displayedAttempt.savedPath, `${shortName(scene)}_x_${shortName(product)}_v${displayedAttempt.version}`)}><DownloadSimple size={17} weight="bold" />下载原图</button>
                      <button className={`btn-send-verification ${sentToVerification ? 'is-sent' : ''}`} onClick={() => sendToVerification(scene, product, task, displayedAttempt)} disabled={sentToVerification || !verificationReady} title={!displayedAttempt.attemptId ? '该历史结果缺少核验记录，请重新生成后提交' : displayedAttempt.integrity === 'unchecked' ? '正在核对落盘文件完整性' : undefined}>
                        {sentToVerification ? <CheckCircle size={17} weight="fill" /> : <ShieldCheck size={17} weight="bold" />}
                        {sentToVerification ? '已发送核验' : displayedAttempt.integrity === 'unchecked' ? '正在核对文件' : displayedAttempt.attemptId ? '确认并发送核验' : '核验记录缺失'}
                      </button>
                    </div>
                  </div>
                  <TaskProgress progress={task.progress} compact />
                  <div className="redo-row"><input aria-label={`${shortName(product)} 的微调要求`} placeholder="补充微调要求后追加一个新版本" value={redoPrompt.get(key) || ''} onChange={(event) => setRedoPrompt(previous => { const next = new Map(previous); if (event.target.value.trim()) next.set(key, event.target.value); else next.delete(key); return next })} /><button className="btn-redo" disabled={isRedoing || generationApiKeys.length === 0} onClick={() => redoPair(scene, product)}>{isRedoing ? <span className="spinner" /> : <ArrowsClockwise size={16} weight="bold" />}{isRedoing ? task.status === 'queued' ? '排队中' : '生成中' : '追加重做版本'}</button></div>
                </article>
              )
            })}
          </div>
        </section>
      )}

      {previewProduct && activeScene && (
        <div className="preview-overlay" role="dialog" aria-modal="true" aria-label="场景与素材对比" onClick={() => setPreviewProduct(null)}>
          <div className="preview-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="preview-heading"><div><strong>场景与素材对比</strong><small>使用左右方向键切换候选素材</small></div><button type="button" onClick={() => setPreviewProduct(null)} aria-label="关闭预览"><X size={19} weight="bold" /></button></div>
            <div className="preview-compare">
              <figure><figcaption>场景缩略图</figcaption><ThumbnailImage src={getThumbnailUrl(activeScene, 480)} alt={`${shortName(activeScene)} 场景缩略图`} eager /></figure>
              <figure><figcaption>参考素材缩略图</figcaption><ThumbnailImage src={getThumbnailUrl(previewProduct, 360)} alt={`${shortName(previewProduct)} 素材缩略图`} eager /></figure>
            </div>
            <div className="preview-footer"><div><strong>{shortName(previewProduct)}</strong><small>{groupByProduct.get(previewProduct) || '未分组'}{productAngles.get(previewProduct) ? `，${ANGLE_LABELS[productAngles.get(previewProduct)!.angle]}` : ''}</small></div><button className={activeSelected.has(previewProduct) ? 'btn-cancel' : 'btn-generate'} onClick={() => toggleProduct(activeScene, previewProduct)}>{activeSelected.has(previewProduct) ? <X size={17} weight="bold" /> : <Check size={17} weight="bold" />}{activeSelected.has(previewProduct) ? '移出选择' : '加入选择'}</button></div>
          </div>
        </div>
      )}
    </div>
  )
}
