import { createHash } from 'crypto'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join, relative, sep } from 'path'
import { assertProjectPath, findProjectRoot } from './projectAccess.js'

export const SCENE_ANGLES = [
  'front',
  'front_right',
  'right',
  'back_right',
  'back',
  'back_left',
  'left',
  'front_left',
  'multiple',
  'unknown',
] as const

export type SceneAngle = typeof SCENE_ANGLES[number]
export type SceneAngleSource = 'model' | 'agent' | 'manual'

export function angleFromAzimuth(azimuth: number): Exclude<SceneAngle, 'multiple' | 'unknown'> {
  const normalized = ((azimuth % 360) + 360) % 360
  if (normalized <= 10 || normalized >= 350) return 'front'
  if (normalized < 80) return 'front_right'
  if (normalized <= 100) return 'right'
  if (normalized < 170) return 'back_right'
  if (normalized <= 190) return 'back'
  if (normalized < 260) return 'back_left'
  if (normalized <= 280) return 'left'
  return 'front_left'
}

export interface SceneAngleAnalysis {
  scenePath: string
  angle: SceneAngle
  azimuth: number | null
  elevation: number | null
  mirrored: boolean
  occlusion: number
  confidence: number
  chairCount: number
  reason: string
  source: SceneAngleSource
  model?: string
  analyzedAt: string
  imageHash: string
  tokenUsage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

export interface SceneAngleInput {
  angle: string
  azimuth?: number | null
  elevation?: number | null
  mirrored?: boolean
  occlusion?: number
  confidence?: number
  chairCount?: number
  reason?: string
}

interface AngleStore {
  version: 1
  updatedAt: string
  scenes: Record<string, Omit<SceneAngleAnalysis, 'scenePath'>>
}

const STORE_DIR = '.scenecolor'
const STORE_FILE = 'scene-angles.json'
const writeQueues = new Map<string, Promise<void>>()

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function normalizeAngle(value: string): SceneAngle {
  if ((SCENE_ANGLES as readonly string[]).includes(value)) return value as SceneAngle
  throw new Error(`不支持的角度分类: ${value}`)
}

function sceneKey(root: string, scenePath: string): string {
  return relative(root, scenePath).split(sep).join('/')
}

function absoluteScenePath(root: string, key: string): string {
  return join(root, ...key.split('/'))
}

function storePath(root: string): string {
  return join(root, STORE_DIR, STORE_FILE)
}

async function emptyStore(): Promise<AngleStore> {
  return { version: 1, updatedAt: new Date(0).toISOString(), scenes: {} }
}

async function readStore(root: string): Promise<AngleStore> {
  try {
    const parsed = JSON.parse(await readFile(storePath(root), 'utf-8')) as AngleStore
    if (parsed.version !== 1 || !parsed.scenes || typeof parsed.scenes !== 'object') return emptyStore()
    return parsed
  } catch {
    return emptyStore()
  }
}

async function writeStore(root: string, store: AngleStore): Promise<void> {
  const path = storePath(root)
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.tmp`
  await writeFile(tempPath, JSON.stringify(store, null, 2), 'utf-8')
  await rename(tempPath, path)
}

async function queueWrite(root: string, operation: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(root) || Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  writeQueues.set(root, current)
  try {
    await current
  } finally {
    if (writeQueues.get(root) === current) writeQueues.delete(root)
  }
}

export async function hashSceneImage(scenePath: string): Promise<string> {
  const safePath = assertProjectPath(scenePath)
  return createHash('sha256').update(await readFile(safePath)).digest('hex')
}

export function normalizeSceneAngleInput(input: SceneAngleInput): Omit<SceneAngleAnalysis, 'scenePath' | 'source' | 'model' | 'analyzedAt' | 'imageHash' | 'tokenUsage'> {
  const requestedAngle = normalizeAngle(String(input.angle || 'unknown'))
  const azimuth = input.azimuth == null ? null : clamp(input.azimuth, 0, 359.9, 0)
  return {
    angle: azimuth != null && requestedAngle !== 'multiple' && requestedAngle !== 'unknown'
      ? angleFromAzimuth(azimuth)
      : requestedAngle,
    azimuth,
    elevation: input.elevation == null ? null : clamp(input.elevation, -90, 90, 0),
    mirrored: Boolean(input.mirrored),
    occlusion: clamp(input.occlusion, 0, 1, 0),
    confidence: clamp(input.confidence, 0, 1, 0),
    chairCount: Math.round(clamp(input.chairCount, 0, 20, 1)),
    reason: String(input.reason || '').trim().slice(0, 1000),
  }
}

export async function saveSceneAngleAnalysis(
  scenePath: string,
  input: SceneAngleInput,
  options: {
    source: SceneAngleSource
    model?: string
    imageHash?: string
    tokenUsage?: SceneAngleAnalysis['tokenUsage']
  },
): Promise<SceneAngleAnalysis> {
  const safePath = assertProjectPath(scenePath)
  const root = findProjectRoot(safePath)
  if (!root) throw new Error('场景图不在已扫描的项目目录内')
  const normalized = normalizeSceneAngleInput(input)
  const analysis: SceneAngleAnalysis = {
    scenePath: safePath,
    ...normalized,
    source: options.source,
    model: options.model,
    analyzedAt: new Date().toISOString(),
    imageHash: options.imageHash || await hashSceneImage(safePath),
    tokenUsage: options.tokenUsage,
  }

  await queueWrite(root, async () => {
    const store = await readStore(root)
    const { scenePath: _scenePath, ...stored } = analysis
    store.scenes[sceneKey(root, safePath)] = stored
    store.updatedAt = analysis.analyzedAt
    await writeStore(root, store)
  })
  return analysis
}

export async function getSceneAngleAnalysis(scenePath: string): Promise<SceneAngleAnalysis | undefined> {
  const safePath = assertProjectPath(scenePath)
  const root = findProjectRoot(safePath)
  if (!root) return undefined
  const store = await readStore(root)
  const stored = store.scenes[sceneKey(root, safePath)]
  return stored ? { scenePath: safePath, ...stored } : undefined
}

export async function getSceneAngleAnalyses(scenePaths: string[]): Promise<SceneAngleAnalysis[]> {
  if (!scenePaths.length) return []
  const grouped = new Map<string, string[]>()
  for (const path of scenePaths) {
    const safePath = assertProjectPath(path)
    const root = findProjectRoot(safePath)
    if (!root) continue
    grouped.set(root, [...(grouped.get(root) || []), safePath])
  }

  const results: SceneAngleAnalysis[] = []
  for (const [root, paths] of grouped) {
    const store = await readStore(root)
    for (const path of paths) {
      const stored = store.scenes[sceneKey(root, path)]
      if (stored) results.push({ scenePath: path, ...stored })
    }
  }
  return results
}

export async function listStoredSceneAngles(root: string): Promise<SceneAngleAnalysis[]> {
  const store = await readStore(root)
  return Object.entries(store.scenes).map(([key, value]) => ({
    scenePath: absoluteScenePath(root, key),
    ...value,
  }))
}
