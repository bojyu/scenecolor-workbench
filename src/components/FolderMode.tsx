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
  getSceneAngles,
  getThumbnail,
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
  WorkflowTaskProgress,
} from '../types'
import TaskProgress from './TaskProgress'
import { createVerificationProgress, createWorkflowProgress, updateWorkflowProgress } from '../lib/workflowProgress'

interface Props {
  nanoBananaApiKeys: string[]
  image2ApiKeys: string[]
  runtime: RuntimeSelection
  runtimeReady: boolean
  onSendToVerification: (item: VerificationQueueItem) => void
  queuedVerificationIds: Set<string>
}

type TaskStatus = 'idle' | 'queued' | 'running' | 'ok' | 'error' | 'cancelled'
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

interface TaskState {
  status: TaskStatus
  progress: WorkflowTaskProgress
  image?: string
  savedPath?: string
  errorMsg?: string
  version?: number
}

function generationTaskProgress(current: WorkflowTaskProgress | undefined, status: TaskStatus, error?: string, incrementAttempt = false): WorkflowTaskProgress {
  const base = current || createWorkflowProgress('generation', { stage: 'queued', stageLabel: '等待生成', percent: 0 })
  if (status === 'queued') return updateWorkflowProgress(base, { status: 'queued', stage: 'queued', stageLabel: '等待可用生成通道', percent: 0 })
  if (status === 'running') return updateWorkflowProgress(base, { status: 'running', stage: 'generating', stageLabel: '场景图生成中', percent: 35, incrementAttempt })
  if (status === 'ok') return updateWorkflowProgress(base, { status: 'waiting-review', stage: 'result', stageLabel: '生成完成，等待确认', percent: 90 })
  if (status === 'error') return updateWorkflowProgress(base, { status: 'failed', stage: 'generating', stageLabel: '生成失败', percent: 35, error })
  if (status === 'cancelled') return updateWorkflowProgress(base, { status: 'cancelled', stage: 'generating', stageLabel: '已停止，可重新执行', percent: 35 })
  return updateWorkflowProgress(base, { status: 'queued', stage: 'queued', stageLabel: '等待生成', percent: 0 })
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
  const [scanError, setScanError] = useState('')
  const [redoing, setRedoing] = useState<string | null>(null)
  const [redoPrompt, setRedoPrompt] = useState<Map<string, string>>(new Map())
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
  const versionRef = useRef<Map<string, number>>(new Map())
  const lockRef = useRef(false)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const candidateScrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scanAbortRef = useRef<AbortController | null>(null)
  const angleKeyCursorRef = useRef(0)
  const generationKeyCursorRef = useRef(0)
  const angleAbortRef = useRef<AbortController | null>(null)
  const productAngleAbortRef = useRef<AbortController | null>(null)
  const referenceTrainingTimersRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    localStorage.setItem('scenecolor_folder_path', folderPath)
  }, [folderPath])

  useEffect(() => () => {
    abortRef.current?.abort()
    scanAbortRef.current?.abort()
    angleAbortRef.current?.abort()
    productAngleAbortRef.current?.abort()
    for (const timer of referenceTrainingTimersRef.current.values()) window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    localStorage.setItem('scenecolor_image_aspect_ratio', aspectRatio)
  }, [aspectRatio])

  useEffect(() => {
    localStorage.setItem('scenecolor_image_model', imageModel)
    generationKeyCursorRef.current = 0
  }, [imageModel])

  useEffect(() => {
    localStorage.setItem('scenecolor_image_resolution', imageResolution)
  }, [imageResolution])

  const generationApiKeys = imageModel === 'gpt-image-2' ? image2ApiKeys : nanoBananaApiKeys

  const handleScan = async () => {
    if (!folderPath.trim()) return
    setScanError(''); setScanning(true); setFilterGroup('')
    setTasks(new Map()); tasksRef.current = new Map()
    setMapping(new Map()); setActiveScene(null); setPrompts(new Map())
    setCheckedScenes(new Set()); setRedoPrompt(new Map()); versionRef.current = new Map()
    setSceneAngles(new Map()); setProductAngles(new Map()); setAngleMatches([])
    setAngleError(''); setAngleSummary('')
    setSkillScenes(new Map()); setSkillMatches([]); setSkillSummary(null)
    setInlineReviewDraft(null); setInlineTrainingStates(new Map())

    scanAbortRef.current?.abort()
    const controller = new AbortController()
    scanAbortRef.current = controller

    try {
      const res = await scanFolder(folderPath.trim(), controller.signal)
      if (!res.success) throw new Error(res.error || '扫描失败')
      if (!res.scenes.length || !res.products.length) {
        throw new Error('未找到图片。请确保文件夹包含 scenes/ 和 products/ 子目录。')
      }

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
    } catch (e: any) {
      if (e?.name !== 'AbortError') setScanError(e.message || '扫描失败')
    } finally {
      if (scanAbortRef.current === controller) scanAbortRef.current = null
      setScanning(false)
    }
  }

  const handleCodexSkillRecognition = async () => {
    setScanError(''); setSkillLoading(true); setFilterGroup('')
    setTasks(new Map()); tasksRef.current = new Map()
    setMapping(new Map()); setActiveScene(null); setPrompts(new Map())
    setCheckedScenes(new Set()); setRedoPrompt(new Map()); versionRef.current = new Map()
    setSceneThumbs(new Map()); setProductThumbs(new Map())
    setProductAngles(new Map()); setAngleMatches([])
    setAngleError(''); setAngleSummary('')
    setInlineReviewDraft(null); setInlineTrainingStates(new Map())

    scanAbortRef.current?.abort()
    const controller = new AbortController()
    scanAbortRef.current = controller

    try {
      const res = await recognizeAnglesWithCodexSkill(folderPath.trim(), runtime, controller.signal)
      if (!res.success || !res.summary) throw new Error(res.error || 'Codex + Skill 角度识别失败')
      if (!res.scenes.length || !res.products.length) throw new Error('项目中没有可用图片')

      setFolderPath(res.root || folderPath)
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

      const selectedProducts = [...new Set(res.matches.flatMap(match => [
        ...(match.productPath ? [match.productPath] : []),
        ...match.supportingReferences.flatMap(reference => reference.productPath ? [reference.productPath] : []),
      ]))]
      const [sceneT, prodT] = await Promise.all([
        loadThumbs(res.scenes, 640, controller.signal),
        loadThumbs(selectedProducts, 160, controller.signal),
      ])
      setSceneThumbs(sceneT); setProductThumbs(prodT)
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
      setInlineTrainingStates(previous => new Map(previous).set(scenePath, { status: 'saved' }))
    } catch (error: any) {
      setInlineTrainingStates(previous => new Map(previous).set(scenePath, {
        status: 'error',
        error: error?.message || '后台学习保存失败',
      }))
    }
  }

  const loadThumbs = async (paths: string[], maxW: number, signal?: AbortSignal) => {
    const map = new Map<string, string>()
    for (let i = 0; i < paths.length; i += 6) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const chunk = paths.slice(i, i + 6)
      await Promise.all(chunk.map(async p => {
        try { map.set(p, await getThumbnail(p, maxW, signal)) }
        catch (e: any) { if (e?.name === 'AbortError') throw e }
      }))
      if (maxW === 640) setSceneThumbs(new Map(map))
      else setProductThumbs(previous => new Map([...previous, ...map]))
    }
    return map
  }

  const scheduleReferenceTraining = (scenePath: string, selectedProductPaths: string[]) => {
    const currentTimer = referenceTrainingTimersRef.current.get(scenePath)
    if (currentTimer) window.clearTimeout(currentTimer)
    const timer = window.setTimeout(async () => {
      referenceTrainingTimersRef.current.delete(scenePath)
      const suggestedProductPaths = skillMatches
        .filter(match => match.scenePath === scenePath)
        .flatMap(match => match.productPath ? [match.productPath] : [])
      setInlineTrainingStates(previous => new Map(previous).set(scenePath, { status: 'saving' }))
      try {
        await saveReferenceTraining(folderPath.trim(), runtime, { scenePath, selectedProductPaths, suggestedProductPaths })
        setInlineTrainingStates(previous => new Map(previous).set(scenePath, { status: 'saved' }))
      } catch (error: any) {
        setInlineTrainingStates(previous => new Map(previous).set(scenePath, {
          status: 'error', error: error?.message || '参考图偏好保存失败',
        }))
      }
    }, 600)
    referenceTrainingTimersRef.current.set(scenePath, timer)
  }

  const toggleProduct = (scene: string, product: string) => {
    const next = new Map(mapping)
    const selected = new Set(next.get(scene) || [])
    if (selected.has(product)) selected.delete(product); else selected.add(product)
    if (selected.size === 0) next.delete(scene); else next.set(scene, selected)
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
    setMapping(next)
  }

  const applySkillMatchesToMapping = (matches: SkillMatchResult[], learnedSelections?: Record<string, string[]>) => {
    const next = new Map<string, Set<string>>()
    for (const match of matches) {
      if (!match.productPath || match.status === 'unmatched') continue
      const selected = next.get(match.scenePath) || new Set<string>()
      selected.add(match.productPath)
      next.set(match.scenePath, selected)
    }
    for (const [scenePath, productPaths] of Object.entries(learnedSelections ?? {})) {
      if (productPaths.length) next.set(scenePath, new Set(productPaths))
      else next.delete(scenePath)
    }
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

  const nextGenerationApiKey = () => {
    const key = generationApiKeys[generationKeyCursorRef.current % generationApiKeys.length] || ''
    generationKeyCursorRef.current += 1
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

  const retryPair = async (scene: string, product: string) => {
    if (!generationApiKeys.length) return
    const key = `${scene}|${product}`
    const t1 = new Map(tasksRef.current)
    const previous = t1.get(key)
    t1.set(key, { status: 'running', version: 1, progress: generationTaskProgress(previous?.progress, 'running', undefined, true) })
    tasksRef.current = t1; setTasks(t1)

    try {
      const res = await generate({
        scenePath: scene, productPath: product, apiKey: nextGenerationApiKey(),
        model: imageModel,
        resolution: imageResolution,
        aspectRatio,
        supportingProductPaths: supportingProductPathsFor(scene, product),
        customPrompt: prompts.get(scene) || defaultPrompt || undefined,
        sceneFile: scene, productFile: product, version: 1,
      })
      const t2 = new Map(tasksRef.current)
      const current = t2.get(key)
      if (res.success && res.image) t2.set(key, { status: 'ok', image: res.image, savedPath: res.savedPath, version: 1, progress: generationTaskProgress(current?.progress, 'ok') })
      else t2.set(key, { status: 'error', errorMsg: res.error || '生成失败', progress: generationTaskProgress(current?.progress, 'error', res.error || '生成失败') })
      tasksRef.current = t2; setTasks(t2)
    } catch (e: any) {
      const t2 = new Map(tasksRef.current)
      const current = t2.get(key)
      t2.set(key, { status: 'error', errorMsg: e.message, progress: generationTaskProgress(current?.progress, 'error', e.message) })
      tasksRef.current = t2; setTasks(t2)
    }
  }

  const redoPair = async (scene: string, product: string) => {
    const key = `${scene}|${product}`
    if (redoing === key || !generationApiKeys.length) return
    setRedoing(key)

    const nextVer = (versionRef.current.get(key) || 1) + 1
    versionRef.current.set(key, nextVer)

    const t1 = new Map(tasksRef.current)
    const previous = t1.get(key)
    t1.set(key, { status: 'running', version: nextVer, progress: generationTaskProgress(previous?.progress, 'running', undefined, true) })
    tasksRef.current = t1; setTasks(t1)

    try {
      const promptForRedo = redoPrompt.get(key) || prompts.get(scene) || defaultPrompt || undefined
      const res = await generate({
        scenePath: scene, productPath: product, apiKey: nextGenerationApiKey(),
        model: imageModel,
        resolution: imageResolution,
        aspectRatio,
        supportingProductPaths: supportingProductPathsFor(scene, product),
        customPrompt: promptForRedo,
        sceneFile: scene, productFile: product, version: nextVer,
      })
      const t2 = new Map(tasksRef.current)
      const current = t2.get(key)
      if (res.success && res.image) t2.set(key, { status: 'ok', image: res.image, savedPath: res.savedPath, version: nextVer, progress: generationTaskProgress(current?.progress, 'ok') })
      else t2.set(key, { status: 'error', errorMsg: res.error || '生成失败', version: nextVer, progress: generationTaskProgress(current?.progress, 'error', res.error || '生成失败') })
      tasksRef.current = t2; setTasks(t2)
    } catch (e: any) {
      const t2 = new Map(tasksRef.current)
      const current = t2.get(key)
      t2.set(key, { status: 'error', errorMsg: e.message, version: nextVer, progress: generationTaskProgress(current?.progress, 'error', e.message) })
      tasksRef.current = t2; setTasks(t2)
    }
    setRedoing(null)
  }

  const handleGenerate = async () => {
    if (lockRef.current || mapping.size === 0 || generationApiKeys.length === 0) return

    const allPairs: { scene: string; product: string }[] = []
    for (const [scene, prodSet] of mapping) {
      if (!checkedScenes.has(scene)) continue
      for (const product of prodSet) allPairs.push({ scene, product })
    }

    const todo = allPairs.filter(p => {
      const s = tasksRef.current.get(`${p.scene}|${p.product}`)
      return !s || s.status === 'error' || s.status === 'idle' || s.status === 'cancelled'
    })
    if (!todo.length) return

    lockRef.current = true; setGenerating(true)

    const t0 = new Map(tasksRef.current)
    for (const p of todo) {
      const key = `${p.scene}|${p.product}`
      versionRef.current.set(key, 1)
      t0.set(key, { status: 'queued', version: 1, progress: generationTaskProgress(undefined, 'queued') })
    }
    tasksRef.current = t0; setTasks(t0)

    const keyCount = generationApiKeys.length
    const controller = new AbortController()
    abortRef.current = controller

    try {
      for (let i = 0; i < todo.length && lockRef.current; i += keyCount) {
        const chunk = todo.slice(i, i + keyCount)
        await Promise.all(chunk.map(async (pair, pos) => {
          if (!lockRef.current) return
          const key = `${pair.scene}|${pair.product}`
          const startingTasks = new Map(tasksRef.current)
          const startingTask = startingTasks.get(key)
          startingTasks.set(key, { ...startingTask, status: 'running', version: 1, progress: generationTaskProgress(startingTask?.progress, 'running') })
          tasksRef.current = startingTasks; setTasks(startingTasks)
          const assignedKey = generationApiKeys[(i + pos) % keyCount]
          const customPrompt = prompts.get(pair.scene) || defaultPrompt || undefined
          try {
            const res = await generate({
              scenePath: pair.scene, productPath: pair.product, apiKey: assignedKey,
              model: imageModel,
              resolution: imageResolution,
              aspectRatio,
              supportingProductPaths: supportingProductPathsFor(pair.scene, pair.product),
              customPrompt, sceneFile: pair.scene, productFile: pair.product, version: 1,
            }, controller.signal)
            const t = new Map(tasksRef.current)
            const current = t.get(key)
            if (res.success && res.image) t.set(key, { status: 'ok', image: res.image, savedPath: res.savedPath, version: 1, progress: generationTaskProgress(current?.progress, 'ok') })
            else t.set(key, { status: 'error', errorMsg: res.error || '生成失败', version: 1, progress: generationTaskProgress(current?.progress, 'error', res.error || '生成失败') })
            tasksRef.current = t; setTasks(t)
          } catch (e: any) {
            if (e?.name === 'AbortError') return
            const t = new Map(tasksRef.current)
            const current = t.get(key)
            t.set(key, { status: 'error', errorMsg: e.message, version: 1, progress: generationTaskProgress(current?.progress, 'error', e.message) })
            tasksRef.current = t; setTasks(t)
          }
        }))
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setGenerating(false); lockRef.current = false
    }
  }

  const handleStop = () => {
    lockRef.current = false
    abortRef.current?.abort()
    const next = new Map(tasksRef.current)
    for (const [key, task] of next) {
      if (task.status === 'running' || task.status === 'queued') next.set(key, { ...task, status: 'cancelled', progress: generationTaskProgress(task.progress, 'cancelled') })
    }
    tasksRef.current = next; setTasks(next)
    setGenerating(false)
  }
  const handleDownload = useCallback((image: string, label: string) => {
    const a = document.createElement('a'); a.href = image; a.download = label + '.png'; a.click()
  }, [])

  const sendToVerification = (scene: string, product: string, task: TaskState) => {
    if (!task.image) return
    const version = task.version || 1
    const id = `${scene}|${product}|v${version}`
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
      scenePath: scene,
      productPath: product,
      supportingProductPaths: supportingProductPathsFor(scene, product),
      outputImage: task.image,
      sceneImage: sceneThumbs.get(scene),
      productImage: productThumbs.get(product),
      savedPath: task.savedPath,
      version,
      queuedAt,
      progress: createVerificationProgress(queuedAt),
    })
  }

  let totalPairs = 0, okCount = 0, errCount = 0, runningCount = 0, queuedCount = 0, cancelledCount = 0
  for (const [scene, prodSet] of mapping) {
    if (!checkedScenes.has(scene)) continue
    totalPairs += prodSet.size
  }
  for (const [key, v] of tasks) {
    const [scene] = key.split('|')
    if (!checkedScenes.has(scene)) continue
    if (v.status === 'ok') okCount++
    else if (v.status === 'error') errCount++
    else if (v.status === 'running') runningCount++
    else if (v.status === 'queued') queuedCount++
    else if (v.status === 'cancelled') cancelledCount++
  }
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
    const missing = visible.filter(product => !productThumbs.has(product))
    if (!missing.length) return
    const controller = new AbortController()
    Promise.all(missing.map(async product => {
      try { return [product, await getThumbnail(product, 260, controller.signal)] as const }
      catch (error: any) {
        if (error?.name === 'AbortError') return null
        return null
      }
    })).then(items => {
      if (controller.signal.aborted) return
      setProductThumbs(previous => {
        const next = new Map(previous)
        for (const item of items) if (item) next.set(item[0], item[1])
        return next
      })
    })
    return () => controller.abort()
  }, [candidateProducts, productThumbs, virtualRowKey])

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
  const generationProgress = totalPairs > 0 ? Math.round(((okCount + errCount) / totalPairs) * 100) : 0

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
                    disabled={generating}
                    onClick={() => setAspectRatio(ratio)}>
                    {ratio === 'auto' ? 'Auto' : ratio}
                  </button>
                ))}
                <label className={`ratio-more ${MORE_ASPECT_RATIO_OPTIONS.includes(aspectRatio) ? 'is-active' : ''}`}>
                  <span>{MORE_ASPECT_RATIO_OPTIONS.includes(aspectRatio) ? aspectRatio : '更多'}</span>
                  <CaretDown size={13} weight="bold" aria-hidden="true" />
                  <select aria-label="更多图像比例" disabled={generating}
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
                    aria-pressed={imageResolution === resolution} disabled={generating} onClick={() => setImageResolution(resolution)}>
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
                          {sceneThumbs.get(scene) ? <img src={sceneThumbs.get(scene)} alt="" decoding="async" /> : <span className="image-skeleton" />}
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
                    {sceneThumbs.get(activeScene) ? <img src={sceneThumbs.get(activeScene)} alt={`${shortName(activeScene)} 场景预览`} /> : <span className="image-skeleton" />}
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
                                {productThumbs.get(product) ? <img src={productThumbs.get(product)} alt="" decoding="async" /> : <span className="image-skeleton" />}
                              </button>
                              <div className="selected-reference-copy"><strong title={shortName(product)}>{shortName(product)}</strong><small>{groupByProduct.get(product) || '未分组'}{skillMatch?.referenceMode === 'multi_view' ? '，多视角参考' : ''}</small></div>
                              <span className={`reference-match-state ${skillMatch?.status === 'review' || angleMatch?.status === 'review' ? 'needs-review' : ''}`}>
                                {task?.status === 'running' ? '生成中' : task?.status === 'ok' ? '已完成' : task?.status === 'error' ? '失败' : skillMatch?.mirrored ? '镜像复核' : skillMatch?.status === 'review' || angleMatch?.status === 'review' ? '待复核' : '已匹配'}
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
                                {productThumbs.get(product) ? <img src={productThumbs.get(product)} alt={`${shortName(product)} 素材预览`} decoding="async" /> : <span className="image-skeleton" />}
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
              <div><strong>{totalPairs} 组待生成</strong><small>{imageModel === 'gpt-image-2' ? 'Image 2' : 'Nano Banana 2'} · {imageResolution} · 已选场景 {checkedScenes.size}/{scenes.length}，预计最多调用 {totalPairs} 次生成接口</small></div>
              {(generating || okCount > 0 || errCount > 0 || cancelledCount > 0) && <div className="generation-status"><span>完成 {okCount}，失败 {errCount}，进行中 {runningCount}，排队 {queuedCount}{cancelledCount ? `，已停止 ${cancelledCount}` : ''}</span><div className="generation-progress"><span style={{ transform: `scaleX(${generationProgress / 100})` }} /></div></div>}
            </div>
            <div className="generation-actions">
              {generationApiKeys.length === 0 && <span className="key-warning"><WarningCircle size={16} weight="fill" />当前模型缺少专属 Key</span>}
              {generating && <button className="btn-cancel" onClick={handleStop}><Stop size={16} weight="fill" />停止</button>}
              <button className="btn-generate" disabled={totalPairs === 0 || generating || generationApiKeys.length === 0} onClick={handleGenerate}>
                {generating ? <span className="spinner" /> : <MagicWand size={18} weight="bold" />}
                {generating ? `生成中 ${okCount + errCount}/${totalPairs}` : `开始生成 ${totalPairs} 组`}
              </button>
            </div>
          </section>

          {tasks.size > 0 && (
            <section className="generation-task-monitor" aria-label="生成任务进度">
              <div className="generation-task-monitor-heading">
                <div><strong>任务进度</strong><small>每组场景与素材独立记录阶段、耗时和失败原因</small></div>
                <span>{okCount + errCount}/{totalPairs} 已有结果</span>
              </div>
              <div className="generation-task-monitor-list">
                {[...tasks.entries()].filter(([key]) => checkedScenes.has(key.split('|')[0])).map(([key, task]) => {
                  const [scene, product] = key.split('|')
                  return (
                    <article key={key}>
                      <div className="generation-task-name"><strong>{shortName(scene)}</strong><small>{shortName(product)}</small></div>
                      <TaskProgress progress={task.progress} compact />
                      {(task.status === 'error' || task.status === 'cancelled') && (
                        <button type="button" className="generation-task-retry" disabled={generationApiKeys.length === 0} onClick={() => retryPair(scene, product)}><ArrowsClockwise size={15} weight="bold" />重试</button>
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
            {[...tasks.entries()].filter(([, task]) => task.status === 'ok').map(([key, task]) => {
              const [scene, product] = key.split('|')
              const isRedoing = redoing === key
              const verificationId = `${scene}|${product}|v${task.version || 1}`
              const sentToVerification = queuedVerificationIds.has(verificationId)
              return (
                <article key={key} className="batch-result-card">
                  <div className="result-compare">
                    <figure><figcaption>原场景</figcaption>{sceneThumbs.get(scene) ? <img src={sceneThumbs.get(scene)} alt={`${shortName(scene)} 原场景`} /> : <span className="image-skeleton" />}</figure>
                    <figure><figcaption>生成结果</figcaption><img src={task.image} alt={`${shortName(scene)} 生成结果`} /></figure>
                  </div>
                  <div className="batch-result-meta">
                    <div><strong>{shortName(scene)}</strong><small>{shortName(product)}{task.version && task.version > 1 ? `，版本 ${task.version}` : ''}</small>{task.savedPath && <small title={task.savedPath}>{task.savedPath}</small>}</div>
                    <div className="batch-result-actions">
                      <button className="btn-download" onClick={() => handleDownload(task.image!, `${shortName(scene)}_x_${shortName(product)}`)}><DownloadSimple size={17} weight="bold" />下载</button>
                      <button className={`btn-send-verification ${sentToVerification ? 'is-sent' : ''}`} onClick={() => sendToVerification(scene, product, task)} disabled={sentToVerification}>
                        {sentToVerification ? <CheckCircle size={17} weight="fill" /> : <ShieldCheck size={17} weight="bold" />}
                        {sentToVerification ? '已发送核验' : '确认并发送核验'}
                      </button>
                    </div>
                  </div>
                  <TaskProgress progress={task.progress} compact />
                  <div className="redo-row"><input aria-label={`${shortName(product)} 的微调要求`} placeholder="补充微调要求后重新生成" value={redoPrompt.get(key) || ''} onChange={(event) => setRedoPrompt(previous => { const next = new Map(previous); if (event.target.value.trim()) next.set(key, event.target.value); else next.delete(key); return next })} /><button className="btn-redo" disabled={isRedoing || generationApiKeys.length === 0} onClick={() => redoPair(scene, product)}>{isRedoing ? <span className="spinner" /> : <ArrowsClockwise size={16} weight="bold" />}{isRedoing ? '生成中' : '重新生成'}</button></div>
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
              <figure><figcaption>场景图</figcaption>{sceneThumbs.get(activeScene) ? <img src={sceneThumbs.get(activeScene)} alt={`${shortName(activeScene)} 场景大图`} /> : <span className="image-skeleton" />}</figure>
              <figure><figcaption>参考素材</figcaption>{productThumbs.get(previewProduct) ? <img src={productThumbs.get(previewProduct)} alt={`${shortName(previewProduct)} 素材大图`} /> : <span className="image-skeleton" />}</figure>
            </div>
            <div className="preview-footer"><div><strong>{shortName(previewProduct)}</strong><small>{groupByProduct.get(previewProduct) || '未分组'}{productAngles.get(previewProduct) ? `，${ANGLE_LABELS[productAngles.get(previewProduct)!.angle]}` : ''}</small></div><button className={activeSelected.has(previewProduct) ? 'btn-cancel' : 'btn-generate'} onClick={() => toggleProduct(activeScene, previewProduct)}>{activeSelected.has(previewProduct) ? <X size={17} weight="bold" /> : <Check size={17} weight="bold" />}{activeSelected.has(previewProduct) ? '移出选择' : '加入选择'}</button></div>
          </div>
        </div>
      )}
    </div>
  )
}
