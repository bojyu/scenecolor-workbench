import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'path'
import { ProductGroup } from './projectScanner.js'
import { ProductAngleAnalysis } from './productAngles.js'
import { SceneAngle, SceneAngleAnalysis } from './sceneAngles.js'

export type AngleMatchStatus = 'auto' | 'review' | 'unmatched'

export interface AngleMatch {
  scenePath: string
  groupName: string
  productPath: string | null
  sceneAngle: SceneAngle
  productAngle: SceneAngle | null
  angleDifference: number | null
  elevationDifference: number | null
  confidence: number
  status: AngleMatchStatus
  reason: string
  matchedAt: string
}

interface MatchStore {
  version: 1
  updatedAt: string
  matches: Record<string, Omit<AngleMatch, 'scenePath'>>
}

const STORE_PATH = '.scenecolor/angle-matches.json'
const writeQueues = new Map<string, Promise<void>>()
const DEFAULT_AZIMUTH: Partial<Record<SceneAngle, number>> = {
  front: 0,
  front_right: 45,
  right: 90,
  back_right: 135,
  back: 180,
  back_left: 225,
  left: 270,
  front_left: 315,
}

function pathKey(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function matchKey(root: string, scenePath: string, groupName: string): string {
  return `${pathKey(root, scenePath)}::${encodeURIComponent(groupName)}`
}

function absolutePath(root: string, path: string | null): string | null {
  return path ? join(root, ...path.split('/')) : null
}

async function readStore(root: string): Promise<MatchStore> {
  try {
    const parsed = JSON.parse(await readFile(join(root, STORE_PATH), 'utf-8')) as MatchStore
    if (parsed.version === 1 && parsed.matches && typeof parsed.matches === 'object') return parsed
  } catch {}
  return { version: 1, updatedAt: new Date(0).toISOString(), matches: {} }
}

async function writeStore(root: string, store: MatchStore): Promise<void> {
  const path = join(root, STORE_PATH)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(store, null, 2), 'utf-8')
  await rename(temporary, path)
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

function circularDifference(a: number, b: number): number {
  const difference = Math.abs(a - b) % 360
  return Math.min(difference, 360 - difference)
}

function azimuthOf(analysis: Pick<SceneAngleAnalysis, 'angle' | 'azimuth'>): number | null {
  return analysis.azimuth ?? DEFAULT_AZIMUTH[analysis.angle] ?? null
}

export function matchSceneToProductGroup(
  scene: SceneAngleAnalysis,
  groupName: string,
  candidates: ProductAngleAnalysis[],
): AngleMatch {
  const matchedAt = new Date().toISOString()
  const sceneAzimuth = azimuthOf(scene)
  if (sceneAzimuth == null || scene.angle === 'multiple' || scene.angle === 'unknown') {
    return {
      scenePath: scene.scenePath, groupName, productPath: null, sceneAngle: scene.angle,
      productAngle: null, angleDifference: null, elevationDifference: null, confidence: 0,
      status: 'unmatched', reason: '场景角度无法用于自动匹配', matchedAt,
    }
  }

  const usable = candidates.flatMap(product => {
    const productAzimuth = azimuthOf(product)
    if (productAzimuth == null || product.angle === 'multiple' || product.angle === 'unknown') return []
    const angleDifference = circularDifference(sceneAzimuth, productAzimuth)
    const elevationDifference = scene.elevation == null || product.elevation == null
      ? 0
      : Math.abs(scene.elevation - product.elevation)
    const geometryScore = Math.max(0, 1 - angleDifference / 120) * Math.max(0.65, 1 - elevationDifference / 120)
    const confidence = Math.max(0, Math.min(1, scene.confidence * product.confidence * geometryScore))
    return [{ product, angleDifference, elevationDifference, confidence }]
  }).sort((a, b) => b.confidence - a.confidence || a.angleDifference - b.angleDifference)

  const best = usable[0]
  if (!best) {
    return {
      scenePath: scene.scenePath, groupName, productPath: null, sceneAngle: scene.angle,
      productAngle: null, angleDifference: null, elevationDifference: null, confidence: 0,
      status: 'unmatched', reason: '该素材组没有可用的角度记录', matchedAt,
    }
  }

  const status: AngleMatchStatus = best.confidence >= 0.8 && best.angleDifference <= 35
    ? 'auto'
    : best.confidence >= 0.6 && best.angleDifference <= 65
      ? 'review'
      : 'unmatched'
  return {
    scenePath: scene.scenePath,
    groupName,
    productPath: status === 'unmatched' ? null : best.product.productPath,
    sceneAngle: scene.angle,
    productAngle: best.product.angle,
    angleDifference: Math.round(best.angleDifference * 10) / 10,
    elevationDifference: Math.round(best.elevationDifference * 10) / 10,
    confidence: Math.round(best.confidence * 1000) / 1000,
    status,
    reason: status === 'auto'
      ? `角度差 ${Math.round(best.angleDifference)}°，可自动预选`
      : status === 'review'
        ? `角度差 ${Math.round(best.angleDifference)}°，建议人工确认`
        : `最佳候选角度差 ${Math.round(best.angleDifference)}° 或置信度不足`,
    matchedAt,
  }
}

export function normalizedProductGroups(products: string[], productGroups: ProductGroup[]): ProductGroup[] {
  if (productGroups.length) {
    const grouped = new Set(productGroups.flatMap(group => group.images))
    const rootImages = products.filter(product => !grouped.has(product))
    return rootImages.length ? [...productGroups, { name: '未分组', images: rootImages }] : productGroups
  }
  return [{ name: '全部素材', images: products }]
}

export async function calculateAndSaveAngleMatches(
  root: string,
  scenes: SceneAngleAnalysis[],
  products: string[],
  productGroups: ProductGroup[],
  productAngles: ProductAngleAnalysis[],
): Promise<AngleMatch[]> {
  const byProduct = new Map(productAngles.map(item => [item.productPath, item]))
  const groups = normalizedProductGroups(products, productGroups)
  const matches = scenes.flatMap(scene => groups.map(group => matchSceneToProductGroup(
    scene,
    group.name,
    group.images.flatMap(path => byProduct.get(path) ? [byProduct.get(path)!] : []),
  )))

  await queueWrite(root, async () => {
    const store = await readStore(root)
    for (const match of matches) {
      const stored = {
        ...match,
        productPath: match.productPath ? pathKey(root, match.productPath) : null,
      }
      const { scenePath: _scenePath, ...withoutScene } = stored
      store.matches[matchKey(root, match.scenePath, match.groupName)] = withoutScene
    }
    store.updatedAt = new Date().toISOString()
    await writeStore(root, store)
  })
  return matches
}

export async function listStoredAngleMatches(root: string): Promise<AngleMatch[]> {
  const store = await readStore(root)
  return Object.entries(store.matches).map(([key, value]) => {
    const separator = key.lastIndexOf('::')
    const sceneKey = separator >= 0 ? key.slice(0, separator) : key
    return {
      scenePath: absolutePath(root, sceneKey)!,
      ...value,
      productPath: absolutePath(root, value.productPath),
    }
  })
}

export function defaultGroupNameForProduct(productPath: string): string {
  const parent = basename(dirname(productPath))
  return parent === 'products' ? basename(productPath, extname(productPath)) : parent
}
