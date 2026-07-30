import { Router, Request, Response } from 'express'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { extname, join } from 'path'
import { createHash } from 'crypto'
import sharp from 'sharp'
import {
  assertProjectPath,
  findProjectRoot,
  isPathInside,
  outputDirFor,
} from '../lib/projectAccess.js'
import { buildGenerationPrompt } from '../lib/prompt.js'
import { scanProject } from '../lib/projectScanner.js'
import {
  getSceneAngleAnalyses,
  getSceneAngleAnalysis,
  hashSceneImage,
  saveSceneAngleAnalysis,
} from '../lib/sceneAngles.js'
import { analyzeSceneAngleWithModel, AngleAnalyzerError } from '../lib/angleAnalyzer.js'
import {
  getProductAngleAnalyses,
  getProductAngleAnalysis,
  hashProductImage,
  saveProductAngleAnalysis,
} from '../lib/productAngles.js'
import { calculateAndSaveAngleMatches, listStoredAngleMatches } from '../lib/angleMatches.js'
import { loadChairSkillResults } from '../lib/skillResults.js'
import { recognizeProjectAnglesWithCodexSkill } from '../lib/codexSkillRecognition.js'
import {
  getSkillTrainingReport,
  publishSkillTrainingReview,
  recalculateSkillTrainingReview,
  saveInlineSkillTrainingReview,
  saveInlineReferenceTraining,
} from '../lib/skillTrainingWorkflow.js'
import { getCodexRuntimeStatus, validateRuntimeSelection } from '../lib/codexRuntime.js'
import {
  buildImageGenerationConfig,
  ImageGenerationConfigError,
  normalizeImageAspectRatio,
  normalizeImageGenerationModel,
  normalizeImageResolution,
  resolveDisplayImageDimensions,
  resolveGptImage2AutoGeometry,
  resolveRelayImageModel,
  validateImageOutputGeometry,
} from '../lib/imageGeneration.js'
import { assertSkillGenerationAllowed, GenerationGateError } from '../lib/generationGate.js'
import {
  listProjectGenerationAttempts,
  recordGenerationAttempt,
} from '../lib/generationAttempts.js'
import { buildDraftProductTruth } from '../lib/productTruth.js'
import { verifyGenerationAttempt } from '../lib/chairVerifier.js'
import {
  buildOutputStem,
  outputFileName,
  saveGeneratedResult,
  type SavedGeneratedResult,
} from '../lib/generatedResults.js'
import { prepareGenerationInputs } from '../lib/generationInput.js'

export const apiRouter = Router()

const IMAGE_MIME = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
])
const CACHE_LIMIT = 6
const CACHE_TTL_MS = 30 * 60 * 1000
const MAX_RESULT_BYTES = 40 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 3 * 60 * 1000
const MAX_ANGLE_ANALYSIS_PER_REQUEST = 50
const THUMBNAIL_CACHE_LIMIT = 96

interface CacheEntry {
  image: string
  createdAt: number
}

const dedupCache = new Map<string, CacheEntry>()
const thumbnailCache = new Map<string, { buffer: Buffer; etag: string }>()
const thumbnailFlights = new Map<string, Promise<{ buffer: Buffer; etag: string }>>()

function getCachedImage(key: string): string | undefined {
  const entry = dedupCache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    dedupCache.delete(key)
    return undefined
  }
  dedupCache.delete(key)
  dedupCache.set(key, entry)
  return entry.image
}

function cacheImage(key: string, image: string): void {
  dedupCache.delete(key)
  dedupCache.set(key, { image, createdAt: Date.now() })
  while (dedupCache.size > CACHE_LIMIT) {
    const oldest = dedupCache.keys().next().value as string | undefined
    if (!oldest) break
    dedupCache.delete(oldest)
  }
}

interface LoadedImage {
  buffer: Buffer
  mime: string
}

async function loadImage(input: string): Promise<LoadedImage> {
  const dataMatch = input.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/)
  if (dataMatch) {
    const buffer = Buffer.from(dataMatch[2], 'base64')
    if (!buffer.length) throw new Error('图片数据为空')
    return { buffer, mime: dataMatch[1] }
  }

  const filePath = assertProjectPath(input)
  const mime = IMAGE_MIME.get(extname(filePath).toLowerCase())
  if (!mime) throw new Error('不支持的图片格式')
  const buffer = await readFile(filePath)
  return { buffer, mime }
}

function outputName(sceneFile: string, productFile: string, version = 1): string {
  return outputFileName(buildOutputStem(sceneFile, productFile), version).slice(0, -4)
}

function dataUriBuffer(image: string): Buffer {
  const match = image.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/)
  if (!match) throw new Error('生成结果不是有效的图片数据')
  const buffer = Buffer.from(match[1], 'base64')
  if (!buffer.length || buffer.length > MAX_RESULT_BYTES) throw new Error('生成图片大小异常')
  return buffer
}

async function saveResult(
  image: string,
  sceneFile?: string,
  productFile?: string,
  version = 1,
): Promise<SavedGeneratedResult | null> {
  if (!sceneFile || !productFile) return null
  return saveGeneratedResult({
    image: dataUriBuffer(image),
    sceneFile,
    productFile,
    requestedVersion: version,
  })
}

async function getThumbnail(
  filePath: string,
  width: number,
): Promise<{ buffer: Buffer; etag: string }> {
  const details = await stat(filePath)
  if (!details.isFile()) throw new Error('缩略图路径不是文件')
  const key = `${filePath}\0${details.size}\0${details.mtimeMs}\0${width}`
  const cached = thumbnailCache.get(key)
  if (cached) {
    thumbnailCache.delete(key)
    thumbnailCache.set(key, cached)
    return cached
  }
  const running = thumbnailFlights.get(key)
  if (running) return running
  const operation = (async () => {
    const buffer = await sharp(filePath)
      .rotate()
      .resize(width, undefined, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 74, progressive: true })
      .toBuffer()
    const etag = `"${createHash('sha256').update(key).update(buffer).digest('base64url')}"`
    const value = { buffer, etag }
    thumbnailCache.set(key, value)
    while (thumbnailCache.size > THUMBNAIL_CACHE_LIMIT) {
      const oldest = thumbnailCache.keys().next().value as string | undefined
      if (!oldest) break
      thumbnailCache.delete(oldest)
    }
    return value
  })()
  thumbnailFlights.set(key, operation)
  try {
    return await operation
  } finally {
    thumbnailFlights.delete(key)
  }
}

async function saveRejectedResult(
  image: string,
  details: unknown,
  sceneFile?: string,
  productFile?: string,
  version = 1,
): Promise<string> {
  if (!sceneFile || !productFile) return ''
  try {
    const safeScene = assertProjectPath(sceneFile)
    const safeProduct = assertProjectPath(productFile)
    const rejectedDir = join(outputDirFor(safeScene), 'rejected')
    await mkdir(rejectedDir, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = `${outputName(safeScene, safeProduct, version)}-ratio-mismatch-${timestamp}`
    const imagePath = join(rejectedDir, `${name}.png`)
    const detailsPath = join(rejectedDir, `${name}.json`)
    const imageBuffer = await sharp(dataUriBuffer(image)).png().toBuffer()
    await Promise.all([
      writeFile(imagePath, imageBuffer),
      writeFile(detailsPath, `${JSON.stringify(details, null, 2)}\n`, 'utf-8'),
    ])
    return imagePath
  } catch {
    return ''
  }
}

function extractImageCandidate(data: any): string | undefined {
  const message = data?.choices?.[0]?.message
  if (Array.isArray(message?.content)) {
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue
      const candidates = [
        part.venus_multimodal_url?.url,
        part.venus_multimodal_url,
        part.image_url?.url,
        part.image_url,
        part.url,
      ]
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.length > 20) return candidate
      }
      if (part.inlineData?.data) {
        return `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`
      }
      if (typeof part.data === 'string') {
        if (part.data.startsWith('data:image/')) return part.data
        if (/^[A-Za-z0-9+/=]{100,}$/.test(part.data)) return `data:image/png;base64,${part.data}`
      }
    }
  }

  const directCandidates = [
    data?.url,
    data?.image,
    data?.image_url,
    data?.data?.[0]?.url,
    data?.data?.[0]?.image_url,
  ]
  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && candidate.length > 20) return candidate
  }
  if (data?.data?.[0]?.b64_json) return `data:image/png;base64,${data.data[0].b64_json}`

  if (typeof message?.content === 'string') {
    const dataUri = message.content.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{100,}/)?.[0]
    if (dataUri) return dataUri
    const url = message.content.match(/https?:\/\/[^\s"'\]]+\.(?:png|jpe?g|webp)(?:\?[^\s"'\]]*)?/i)?.[0]
    if (url) return url
  }
  return undefined
}

async function normalizeResultImage(candidate: string, signal: AbortSignal): Promise<string> {
  if (candidate.startsWith('data:image/')) {
    const buffer = dataUriBuffer(candidate)
    await sharp(buffer).metadata()
    return candidate
  }
  if (!candidate.startsWith('http://') && !candidate.startsWith('https://')) {
    throw new Error('接口返回了无法识别的图片格式')
  }

  const response = await fetch(candidate, { signal })
  if (!response.ok) throw new Error(`下载生成图片失败 (${response.status})`)
  const declaredSize = Number(response.headers.get('content-length') || 0)
  if (declaredSize > MAX_RESULT_BYTES) throw new Error('生成图片超过大小限制')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!buffer.length || buffer.length > MAX_RESULT_BYTES) throw new Error('生成图片大小异常')
  const metadata = await sharp(buffer).metadata()
  const mime = metadata.format || 'png'
  return `data:image/${mime};base64,${buffer.toString('base64')}`
}

async function saveFailureResponse(
  data: unknown,
  sceneFile?: string,
  productFile?: string,
  version = 1,
): Promise<string> {
  if (!sceneFile || !productFile) return ''
  try {
    const safeScene = assertProjectPath(sceneFile)
    const safeProduct = assertProjectPath(productFile)
    const outputDir = join(outputDirFor(safeScene), 'raw_json')
    await mkdir(outputDir, { recursive: true })
    const outputFile = join(outputDir, `${outputName(safeScene, safeProduct, version)}.json`)
    await writeFile(outputFile, JSON.stringify(data, null, 2), 'utf-8')
    return outputFile
  } catch {
    return ''
  }
}

apiRouter.post('/scan-folder', async (req: Request, res: Response) => {
  try {
    const folderPath = typeof req.body?.folderPath === 'string' ? req.body.folderPath.trim() : ''
    if (!folderPath) {
      res.status(400).json({ success: false, error: '文件夹不存在', scenes: [], products: [], productGroups: [], sceneAngles: [], productAngles: [], angleMatches: [] })
      return
    }
    const project = await scanProject(folderPath)
    const [sceneAngles, productAngles, storedAngleMatches] = await Promise.all([
      getSceneAngleAnalyses(project.scenes),
      getProductAngleAnalyses(project.products),
      listStoredAngleMatches(project.root),
    ])
    const sceneSet = new Set(project.scenes)
    const productSet = new Set(project.products)
    const angleMatches = storedAngleMatches.filter(match =>
      sceneSet.has(match.scenePath) && (!match.productPath || productSet.has(match.productPath)),
    )
    res.json({ success: true, ...project, sceneAngles, productAngles, angleMatches })
  } catch (error: any) {
    const status = error.message === '文件夹不存在' ? 400 : 500
    res.status(status).json({ success: false, error: error.message, scenes: [], products: [], productGroups: [], sceneAngles: [], productAngles: [], angleMatches: [] })
  }
})

apiRouter.post('/load-skill-results', async (req: Request, res: Response) => {
  try {
    const requestedPath = typeof req.body?.folderPath === 'string' ? req.body.folderPath.trim() : ''
    const folderPath = requestedPath || join(process.cwd(), '套版')
    const project = await scanProject(folderPath)
    const skillResults = await loadChairSkillResults(project)
    res.json({ success: true, ...project, ...skillResults })
  } catch (error: any) {
    const status = error.message === '文件夹不存在' ? 400 : 500
    res.status(status).json({
      success: false,
      error: error.message,
      scenes: [],
      products: [],
      productGroups: [],
      sceneResults: [],
      matches: [],
    })
  }
})

apiRouter.get('/ai-runtime/status', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, runtime: await getCodexRuntimeStatus(process.cwd()) })
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.message || 'Codex 后台状态检查失败' })
  }
})

apiRouter.post('/recognize-angles-with-skill', async (req: Request, res: Response) => {
  const controller = new AbortController()
  const abortIfDisconnected = () => {
    if (!res.writableEnded) controller.abort()
  }
  req.once('aborted', abortIfDisconnected)
  res.once('close', abortIfDisconnected)

  try {
    const folderPath = typeof req.body?.folderPath === 'string' ? req.body.folderPath.trim() : ''
    if (!folderPath) {
      res.status(400).json({ success: false, error: '请先填写项目文件夹路径' })
      return
    }
    const project = await scanProject(folderPath)
    const runtime = validateRuntimeSelection(req.body?.runtime)
    const recognition = await recognizeProjectAnglesWithCodexSkill(project, controller.signal, { runtime })
    const skillResults = await loadChairSkillResults(project, runtime.skillId)
    res.json({ success: true, ...project, ...skillResults, recognition: recognition.recognition })
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      if (!res.headersSent && !res.writableEnded) res.status(499).json({ success: false, error: 'Codex 角度识别已取消' })
      return
    }
    if (!res.headersSent && !res.writableEnded) {
      const message = error?.message || 'Codex + Skill 角度识别失败'
      const status = message === '文件夹不存在' || message.includes('单次最多') || message.includes('缺少') ? 400 : 500
      res.status(status).json({ success: false, error: message })
    }
  } finally {
    req.off('aborted', abortIfDisconnected)
    res.off('close', abortIfDisconnected)
  }
})

apiRouter.post('/recalculate-skill-training', async (req: Request, res: Response) => {
  const controller = new AbortController()
  const abortIfDisconnected = () => { if (!res.writableEnded) controller.abort() }
  req.once('aborted', abortIfDisconnected)
  res.once('close', abortIfDisconnected)
  try {
    const folderPath = typeof req.body?.folderPath === 'string' ? req.body.folderPath.trim() : ''
    const reviews = Array.isArray(req.body?.reviews) ? req.body.reviews : []
    if (!folderPath || !reviews.length) {
      res.status(400).json({ success: false, error: '请先完成全部场景的人工核对' })
      return
    }
    const project = await scanProject(folderPath)
    const runtime = validateRuntimeSelection(req.body?.runtime)
    const review = await recalculateSkillTrainingReview(project, reviews, runtime.skillId, controller.signal)
    const skillResults = await loadChairSkillResults(project, runtime.skillId)
    res.json({ success: true, ...project, ...skillResults, review })
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      if (!res.headersSent && !res.writableEnded) res.status(499).json({ success: false, error: '人工调整计算已取消' })
      return
    }
    if (!res.headersSent && !res.writableEnded) res.status(400).json({ success: false, error: error?.message || '人工调整计算失败' })
  } finally {
    req.off('aborted', abortIfDisconnected)
    res.off('close', abortIfDisconnected)
  }
})

apiRouter.post('/save-inline-skill-training', async (req: Request, res: Response) => {
  try {
    const folderPath = typeof req.body?.folderPath === 'string' ? req.body.folderPath.trim() : ''
    const review = req.body?.review
    if (!folderPath || !review || typeof review !== 'object') {
      res.status(400).json({ success: false, error: 'Inline training parameters are incomplete' })
      return
    }
    const project = await scanProject(folderPath)
    const runtime = validateRuntimeSelection(req.body?.runtime)
    const result = await saveInlineSkillTrainingReview(project, review, runtime.skillId)
    const skillResults = await loadChairSkillResults(project, runtime.skillId)
    res.json({ success: true, ...result, ...skillResults })
  } catch (error: any) {
    res.status(400).json({ success: false, error: error?.message || 'Inline training save failed' })
  }
})

apiRouter.post('/save-reference-training', async (req: Request, res: Response) => {
  try {
    const folderPath = typeof req.body?.folderPath === 'string' ? req.body.folderPath.trim() : ''
    const feedback = req.body?.feedback
    if (!folderPath || !feedback || typeof feedback !== 'object') {
      res.status(400).json({ success: false, error: 'Reference training parameters are incomplete' })
      return
    }
    const project = await scanProject(folderPath)
    const runtime = validateRuntimeSelection(req.body?.runtime)
    const result = await saveInlineReferenceTraining(project, feedback, runtime.skillId)
    res.json({ success: true, ...result })
  } catch (error: any) {
    res.status(400).json({ success: false, error: error?.message || 'Reference training save failed' })
  }
})

apiRouter.post('/product-truth/index', async (req: Request, res: Response) => {
  try {
    const folderPath = typeof req.body?.folderPath === 'string' ? req.body.folderPath.trim() : ''
    if (!folderPath) {
      res.status(400).json({ success: false, error: '缺少项目文件夹路径' })
      return
    }
    const project = await scanProject(folderPath)
    const result = await buildDraftProductTruth(project)
    res.json({ success: true, ...result })
  } catch (error: any) {
    res.status(400).json({ success: false, error: error?.message || '产品真值草稿建立失败' })
  }
})

apiRouter.post('/verification/run', async (req: Request, res: Response) => {
  const controller = new AbortController()
  const abortIfDisconnected = () => { if (!res.writableEnded) controller.abort() }
  req.once('aborted', abortIfDisconnected)
  res.once('close', abortIfDisconnected)
  try {
    const attemptId = typeof req.body?.attemptId === 'string' ? req.body.attemptId.trim() : ''
    if (!attemptId) {
      res.status(400).json({ success: false, error: '缺少生成尝试 ID，请重新生成后再核验' })
      return
    }
    const projectPath = typeof req.body?.projectPath === 'string' ? req.body.projectPath.trim() : ''
    const projectRoot = projectPath ? findProjectRoot(assertProjectPath(projectPath)) || undefined : undefined
    const runtime = validateRuntimeSelection(req.body?.runtime)
    const result = await verifyGenerationAttempt(attemptId, runtime, controller.signal, { projectRoot })
    res.json({ success: true, ...result })
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      if (!res.headersSent && !res.writableEnded) {
        res.status(499).json({ success: false, error: '核验已取消' })
      }
      return
    }
    if (!res.headersSent && !res.writableEnded) {
      const message = error?.message || '核验失败'
      const status = message.includes('ID') || message.includes('不存在') || message.includes('失效') ? 400 : 500
      res.status(status).json({ success: false, error: message })
    }
  } finally {
    req.off('aborted', abortIfDisconnected)
    res.off('close', abortIfDisconnected)
  }
})

apiRouter.post('/skill-training-report', async (req: Request, res: Response) => {
  try {
    const folderPath = typeof req.body?.folderPath === 'string' ? req.body.folderPath.trim() : ''
    if (!folderPath) throw new Error('Please provide a training project path')
    const project = await scanProject(folderPath)
    const runtime = validateRuntimeSelection(req.body?.runtime)
    res.json({ success: true, report: await getSkillTrainingReport(project, runtime.skillId) })
  } catch (error: any) {
    res.status(400).json({ success: false, error: error?.message || 'Training report load failed' })
  }
})

apiRouter.post('/publish-skill-training', async (req: Request, res: Response) => {
  try {
    const folderPath = typeof req.body?.folderPath === 'string' ? req.body.folderPath.trim() : ''
    const reviewId = typeof req.body?.reviewId === 'string' ? req.body.reviewId.trim() : ''
    const target = req.body?.target
    if (!folderPath || !reviewId || !['skill', 'database'].includes(target)) {
      res.status(400).json({ success: false, error: '训练发布参数不完整' })
      return
    }
    const project = await scanProject(folderPath)
    const publication = await publishSkillTrainingReview(project, reviewId, target)
    res.json({ success: true, publication })
  } catch (error: any) {
    res.status(400).json({ success: false, error: error?.message || '训练案例发布失败' })
  }
})

apiRouter.post('/product-angles', async (req: Request, res: Response) => {
  try {
    const productPaths = Array.isArray(req.body?.productPaths) ? req.body.productPaths : []
    const results = await getProductAngleAnalyses(productPaths)
    res.json({ success: true, results })
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message, results: [] })
  }
})

apiRouter.post('/auto-match-angles', async (req: Request, res: Response) => {
  try {
    const folderPath = typeof req.body?.folderPath === 'string' ? req.body.folderPath.trim() : ''
    if (!folderPath) throw new Error('文件夹不存在')
    const project = await scanProject(folderPath)
    const [sceneAngles, productAngles] = await Promise.all([
      getSceneAngleAnalyses(project.scenes),
      getProductAngleAnalyses(project.products),
    ])
    const matches = await calculateAndSaveAngleMatches(
      project.root,
      sceneAngles,
      project.products,
      project.productGroups,
      productAngles,
    )
    res.json({ success: true, matches })
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message, matches: [] })
  }
})

apiRouter.post('/scene-angles', async (req: Request, res: Response) => {
  try {
    const scenePaths = Array.isArray(req.body?.scenePaths) ? req.body.scenePaths : []
    const results = await getSceneAngleAnalyses(scenePaths)
    res.json({ success: true, results })
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message, results: [] })
  }
})

apiRouter.post('/analyze-scene-angles', async (req: Request, res: Response) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const abortIfDisconnected = () => {
    if (!res.writableEnded) controller.abort()
  }
  req.once('aborted', abortIfDisconnected)
  res.once('close', abortIfDisconnected)

  try {
    const requestedPaths: unknown[] = Array.isArray(req.body?.scenePaths) ? req.body.scenePaths : []
    const scenePaths: string[] = [...new Set<string>(
      requestedPaths.filter((value): value is string => typeof value === 'string'),
    )]
    if (!scenePaths.length) {
      res.status(400).json({ success: false, error: '没有需要识别的场景图' })
      return
    }
    if (scenePaths.length > MAX_ANGLE_ANALYSIS_PER_REQUEST) {
      res.status(400).json({ success: false, error: `单次最多识别 ${MAX_ANGLE_ANALYSIS_PER_REQUEST} 张场景图` })
      return
    }

    const apiKey = req.body?.apiKey || process.env.API_KEY
    if (!apiKey) {
      res.status(400).json({ success: false, error: '请先设置 API Key' })
      return
    }
    const results = []
    const errors: { scenePath: string; error: string }[] = []
    let callsMade = 0
    let cachedCount = 0
    let totalTokens = 0

    for (const scenePath of scenePaths) {
      if (controller.signal.aborted) break
      try {
        const safePath = assertProjectPath(scenePath)
        const imageHash = await hashSceneImage(safePath)
        const existing = await getSceneAngleAnalysis(safePath)
        if (existing?.imageHash === imageHash) {
          results.push({ ...existing, cached: true })
          cachedCount += 1
          continue
        }

        const response = await analyzeSceneAngleWithModel(safePath, apiKey, controller.signal)
        callsMade += 1
        totalTokens += response.tokenUsage?.totalTokens || 0
        const saved = await saveSceneAngleAnalysis(safePath, response.analysis, {
          source: 'model',
          model: response.model,
          imageHash,
          tokenUsage: response.tokenUsage,
        })
        results.push({ ...saved, cached: false })
      } catch (error: any) {
        errors.push({ scenePath, error: error.message || '识别失败' })
        if (error instanceof AngleAnalyzerError && (error.status === 401 || error.status === 403)) break
      }
    }

    res.json({ success: errors.length === 0, results, errors, callsMade, cachedCount, totalTokens })
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      if (!res.headersSent && !res.writableEnded) res.status(499).json({ success: false, error: '角度识别已取消或超时' })
      return
    }
    if (!res.headersSent && !res.writableEnded) {
      res.status(500).json({ success: false, error: error.message || '角度识别失败' })
    }
  } finally {
    clearTimeout(timeout)
    req.off('aborted', abortIfDisconnected)
    res.off('close', abortIfDisconnected)
  }
})

apiRouter.post('/analyze-product-angles', async (req: Request, res: Response) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const abortIfDisconnected = () => {
    if (!res.writableEnded) controller.abort()
  }
  req.once('aborted', abortIfDisconnected)
  res.once('close', abortIfDisconnected)

  try {
    const requestedPaths: unknown[] = Array.isArray(req.body?.productPaths) ? req.body.productPaths : []
    const productPaths: string[] = [...new Set<string>(
      requestedPaths.filter((value): value is string => typeof value === 'string'),
    )]
    if (!productPaths.length) {
      res.status(400).json({ success: false, error: '没有需要识别的图2素材' })
      return
    }
    if (productPaths.length > MAX_ANGLE_ANALYSIS_PER_REQUEST) {
      res.status(400).json({ success: false, error: `单次最多识别 ${MAX_ANGLE_ANALYSIS_PER_REQUEST} 张图2素材` })
      return
    }
    const apiKey = req.body?.apiKey || process.env.API_KEY
    if (!apiKey) {
      res.status(400).json({ success: false, error: '请先设置 API Key' })
      return
    }

    const results = []
    const errors: { productPath: string; error: string }[] = []
    let callsMade = 0
    let cachedCount = 0
    let totalTokens = 0
    for (const productPath of productPaths) {
      if (controller.signal.aborted) break
      try {
        const safePath = assertProjectPath(productPath)
        const imageHash = await hashProductImage(safePath)
        const existing = await getProductAngleAnalysis(safePath)
        if (existing?.imageHash === imageHash) {
          results.push({ ...existing, cached: true })
          cachedCount += 1
          continue
        }
        const response = await analyzeSceneAngleWithModel(safePath, apiKey, controller.signal)
        callsMade += 1
        totalTokens += response.tokenUsage?.totalTokens || 0
        const saved = await saveProductAngleAnalysis(safePath, response.analysis, {
          source: 'model',
          model: response.model,
          imageHash,
          tokenUsage: response.tokenUsage,
        })
        results.push({ ...saved, cached: false })
      } catch (error: any) {
        errors.push({ productPath, error: error.message || '识别失败' })
        if (error instanceof AngleAnalyzerError && (error.status === 401 || error.status === 403)) break
      }
    }
    res.json({ success: errors.length === 0, results, errors, callsMade, cachedCount, totalTokens })
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      if (!res.headersSent && !res.writableEnded) res.status(499).json({ success: false, error: '图2角度识别已取消或超时' })
      return
    }
    if (!res.headersSent && !res.writableEnded) {
      res.status(500).json({ success: false, error: error.message || '图2角度识别失败' })
    }
  } finally {
    clearTimeout(timeout)
    req.off('aborted', abortIfDisconnected)
    res.off('close', abortIfDisconnected)
  }
})

apiRouter.post('/generate', async (req: Request, res: Response) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const abortIfDisconnected = () => {
    if (!res.writableEnded) controller.abort()
  }
  req.once('aborted', abortIfDisconnected)
  res.once('close', abortIfDisconnected)

  try {
    const {
      scenePath,
      productPath,
      supportingProductPaths,
      aspectRatio: requestedAspectRatio,
      model: requestedModel,
      resolution: requestedResolution,
      apiKey,
      customPrompt,
      sceneFile,
      productFile,
      version: requestedVersion = 1,
    } = req.body as {
      scenePath: string
      productPath: string
      supportingProductPaths?: string[]
      aspectRatio?: string
      model?: string
      resolution?: string
      apiKey: string
      customPrompt?: string
      sceneFile?: string
      productFile?: string
      version?: number
    }

    const version = Number.isInteger(requestedVersion)
      ? Math.min(999, Math.max(1, requestedVersion))
      : 1
    const additionalInstructions = typeof customPrompt === 'string'
      ? customPrompt.slice(0, 4000)
      : undefined
    const aspectRatio = normalizeImageAspectRatio(requestedAspectRatio)
    const model = normalizeImageGenerationModel(requestedModel)
    const resolution = normalizeImageResolution(requestedResolution)
    const relayModel = resolveRelayImageModel(model, resolution)

    if (!scenePath || !productPath) {
      res.status(400).json({ success: false, error: '缺少场景图或产品图' })
      return
    }
    await assertSkillGenerationAllowed(scenePath, productPath)
    const supportingPaths = Array.isArray(supportingProductPaths)
      ? [...new Set(supportingProductPaths.filter(path => typeof path === 'string' && path && path !== productPath))].slice(0, 2)
      : []
    const key = apiKey || process.env.API_KEY
    if (!key) {
      res.status(400).json({ success: false, error: '请先设置 API Key' })
      return
    }

    const loadedImages = await Promise.all([
      loadImage(scenePath),
      loadImage(productPath),
      ...supportingPaths.map(path => loadImage(path)),
    ])
    const preparedImages = await prepareGenerationInputs(loadedImages.map(image => ({
      source: image.buffer,
      mime: image.mime,
    })))
    const [scene, product, ...supportingProducts] = loadedImages.map((image, index) => ({
      ...image,
      dataUri: preparedImages[index].dataUri,
    }))
    const metadata = await sharp(scene.buffer).metadata()
    const dimensions = resolveDisplayImageDimensions(metadata)
    const autoGeometry = model === 'gpt-image-2' && aspectRatio === 'auto' && dimensions
      ? resolveGptImage2AutoGeometry(dimensions, resolution)
      : undefined
    const generationConfig = buildImageGenerationConfig(aspectRatio, resolution, {
      model,
      sourceDimensions: dimensions,
    })
    const prompt = buildGenerationPrompt(additionalInstructions, dimensions, {
      supportingReferenceCount: supportingProducts.length,
      aspectRatio,
      sourceAspectRatio: dimensions ? `${dimensions.width}:${dimensions.height}` : undefined,
      outputDimensions: autoGeometry,
    })
    const cacheHash = createHash('sha256')
      .update(scene.buffer)
      .update(product.buffer)
    for (const supportingProduct of supportingProducts) cacheHash.update(supportingProduct.buffer)
    const cacheKey = cacheHash
      .update(prompt)
      .update(aspectRatio)
      .update(relayModel)
      .update(resolution)
      .update(JSON.stringify(generationConfig))
      .update(String(version))
      .digest('hex')
    const persistAttempt = async (saved: SavedGeneratedResult | null, cached: boolean) => {
      const savedPath = saved?.savedPath || ''
      if (!saved || !savedPath || scenePath.startsWith('data:image/') || productPath.startsWith('data:image/')) {
        return { attempt: null, warning: '' }
      }
      const projectRoot = findProjectRoot(scenePath)
      if (!projectRoot) return { attempt: null, warning: '未找到项目根目录，本次结果无法进入自动核验' }
      try {
        const attempt = await recordGenerationAttempt({
          projectRoot,
          scenePath,
          productPath,
          supportingProductPaths: supportingPaths,
          inputBuffers: {
            scene: scene.buffer,
            product: product.buffer,
            supporting: supportingProducts.map(reference => reference.buffer),
          },
          outputPath: savedPath,
          model: relayModel,
          resolution,
          aspectRatio,
          version: saved.version,
          prompt,
          cached,
        })
        return { attempt, warning: '' }
      } catch (error: any) {
        return {
          attempt: null,
          warning: `生成结果已保存，但核验记录建立失败：${error?.message || '未知错误'}`,
        }
      }
    }

    const cached = getCachedImage(cacheKey)
    if (cached) {
      const saved = await saveResult(cached, sceneFile, productFile, version)
      const persistence = await persistAttempt(saved, true)
      res.json({
        success: true,
        ...(saved ? {} : { image: cached }),
        savedPath: saved?.savedPath || '',
        version: saved?.version || version,
        width: saved?.width,
        height: saved?.height,
        cached: true,
        attemptId: persistence.attempt?.attemptId,
        attemptWarning: persistence.warning || undefined,
      })
      return
    }

    const response = await fetch('https://ai.comfly.org/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: relayModel,
        ...generationConfig,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: scene.dataUri } },
            { type: 'image_url', image_url: { url: product.dataUri } },
            ...supportingProducts.map(reference => ({
              type: 'image_url',
              image_url: { url: reference.dataUri },
            })),
          ],
        }],
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const message = (await response.text()).slice(0, 1000)
      res.status(response.status).json({ success: false, error: `API 错误 (${response.status}): ${message}` })
      return
    }

    const data = await response.json() as any
    const candidate = extractImageCandidate(data)
    if (!candidate) {
      const rawPath = await saveFailureResponse(data, sceneFile, productFile, version)
      res.status(502).json({
        success: false,
        error: `无法解析接口返回的图片${rawPath ? `，原始响应已保存到 ${rawPath}` : ''}`,
      })
      return
    }

    let resultImage: string
    try {
      resultImage = await normalizeResultImage(candidate, controller.signal)
    } catch (error: any) {
      const rawPath = await saveFailureResponse(data, sceneFile, productFile, version)
      res.status(502).json({
        success: false,
        error: `${error.message}${rawPath ? `，原始响应已保存到 ${rawPath}` : ''}`,
      })
      return
    }

    if (autoGeometry) {
      const resultMetadata = await sharp(dataUriBuffer(resultImage)).metadata()
      const resultDimensions = resolveDisplayImageDimensions(resultMetadata)
      const validation = resultDimensions
        ? validateImageOutputGeometry(autoGeometry, resultDimensions)
        : { ratioMatches: false, sizeMatches: false, valid: false }
      if (!validation.valid) {
        const actual = resultDimensions
          ? `${resultDimensions.width}×${resultDimensions.height}`
          : '无法读取'
        const rejectedPath = await saveRejectedResult(resultImage, {
          reason: 'image_geometry_mismatch',
          providerRequestId: response.headers.get('x-request-id')
            || response.headers.get('request-id')
            || response.headers.get('cf-ray')
            || undefined,
          model: relayModel,
          sourceDimensions: dimensions,
          requestedGeometry: autoGeometry,
          actualDimensions: resultDimensions,
          validation,
          generationConfig,
        }, sceneFile, productFile, version)
        res.status(502).json({
          success: false,
          error: `Image 2 未按图1画布返回：请求 ${autoGeometry.size}，实际 ${actual}。结果未进入正式输出或缓存${rejectedPath ? `，诊断图已保存到 ${rejectedPath}` : ''}。`,
        })
        return
      }
      if (!validation.sizeMatches) {
        const normalized = await sharp(dataUriBuffer(resultImage))
          .resize(autoGeometry.width, autoGeometry.height, { fit: 'fill' })
          .png()
          .toBuffer()
        resultImage = `data:image/png;base64,${normalized.toString('base64')}`
      }
    }

    const saved = await saveResult(resultImage, sceneFile, productFile, version)
    cacheImage(cacheKey, resultImage)
    const persistence = await persistAttempt(saved, false)
    res.json({
      success: true,
      ...(saved ? {} : { image: resultImage }),
      savedPath: saved?.savedPath || '',
      version: saved?.version || version,
      width: saved?.width,
      height: saved?.height,
      attemptId: persistence.attempt?.attemptId,
      attemptWarning: persistence.warning || undefined,
    })
  } catch (error: any) {
    if (error instanceof ImageGenerationConfigError) {
      if (!res.headersSent && !res.writableEnded) {
        res.status(error.statusCode).json({ success: false, code: error.code, error: error.message })
      }
      return
    }
    if (error instanceof GenerationGateError) {
      if (!res.headersSent && !res.writableEnded) {
        res.status(error.statusCode).json({ success: false, code: error.code, error: error.message })
      }
      return
    }
    if (error?.name === 'AbortError') {
      if (!res.headersSent && !res.writableEnded) {
        res.status(499).json({ success: false, error: '生成已取消或请求超时' })
      }
      return
    }
    if (!res.headersSent && !res.writableEnded) {
      res.status(500).json({ success: false, error: error.message || '生成失败' })
    }
  } finally {
    clearTimeout(timeout)
    req.off('aborted', abortIfDisconnected)
    res.off('close', abortIfDisconnected)
  }
})

apiRouter.get('/thumbnail', async (req: Request, res: Response) => {
  try {
    const filePath = assertProjectPath(typeof req.query.path === 'string' ? req.query.path : '')
    const requestedWidth = Number(req.query.w)
    const width = Number.isFinite(requestedWidth)
      ? Math.min(1280, Math.max(48, Math.round(requestedWidth)))
      : 320
    const thumbnail = await getThumbnail(filePath, width)
    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': String(thumbnail.buffer.length),
      'Cache-Control': 'private, max-age=3600',
      ETag: thumbnail.etag,
    })
    if (req.headers['if-none-match'] === thumbnail.etag) {
      res.status(304).end()
      return
    }
    res.send(thumbnail.buffer)
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message })
  }
})

apiRouter.post('/thumbnail', async (req: Request, res: Response) => {
  try {
    const filePath = assertProjectPath(req.body?.path)
    const requestedWidth = Number(req.body?.w)
    const width = Number.isFinite(requestedWidth)
      ? Math.min(1280, Math.max(48, Math.round(requestedWidth)))
      : 320
    const thumbnail = await getThumbnail(filePath, width)
    res.json({ success: true, data: `data:image/jpeg;base64,${thumbnail.buffer.toString('base64')}` })
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message })
  }
})

apiRouter.get('/generation-result', async (req: Request, res: Response) => {
  try {
    const filePath = assertProjectPath(typeof req.query.path === 'string' ? req.query.path : '')
    if (extname(filePath).toLowerCase() !== '.png' || !isPathInside(outputDirFor(filePath), filePath)) {
      res.status(400).json({ success: false, error: '只能下载项目输出目录中的 PNG 结果' })
      return
    }
    res.download(filePath)
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message })
  }
})

apiRouter.post('/generation-attempts/list', async (req: Request, res: Response) => {
  try {
    const requestedPath = typeof req.body?.folderPath === 'string' ? req.body.folderPath.trim() : ''
    if (!requestedPath) {
      res.status(400).json({ success: false, error: '缺少项目文件夹' })
      return
    }
    const projectPath = assertProjectPath(requestedPath)
    const projectRoot = findProjectRoot(projectPath)
    if (!projectRoot) {
      res.status(400).json({ success: false, error: '项目尚未扫描' })
      return
    }
    res.json({
      success: true,
      attempts: await listProjectGenerationAttempts(projectRoot, {
        mode: req.body?.mode === 'audit' ? 'audit' : 'metadata',
      }),
    })
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message })
  }
})
