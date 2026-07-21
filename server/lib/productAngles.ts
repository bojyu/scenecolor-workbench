import { createHash } from 'crypto'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join, relative, sep } from 'path'
import { assertProjectPath, findProjectRoot } from './projectAccess.js'
import {
  normalizeSceneAngleInput,
  SceneAngleAnalysis,
  SceneAngleInput,
  SceneAngleSource,
} from './sceneAngles.js'

export interface ProductAngleAnalysis extends Omit<SceneAngleAnalysis, 'scenePath'> {
  productPath: string
}

interface ProductAngleStore {
  version: 1
  updatedAt: string
  products: Record<string, Omit<ProductAngleAnalysis, 'productPath'>>
}

const STORE_PATH = '.scenecolor/product-angles.json'
const writeQueues = new Map<string, Promise<void>>()

function productKey(root: string, productPath: string): string {
  return relative(root, productPath).split(sep).join('/')
}

function absoluteProductPath(root: string, key: string): string {
  return join(root, ...key.split('/'))
}

async function readStore(root: string): Promise<ProductAngleStore> {
  try {
    const parsed = JSON.parse(await readFile(join(root, STORE_PATH), 'utf-8')) as ProductAngleStore
    if (parsed.version === 1 && parsed.products && typeof parsed.products === 'object') return parsed
  } catch {}
  return { version: 1, updatedAt: new Date(0).toISOString(), products: {} }
}

async function writeStore(root: string, store: ProductAngleStore): Promise<void> {
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

export async function hashProductImage(productPath: string): Promise<string> {
  const safePath = assertProjectPath(productPath)
  return createHash('sha256').update(await readFile(safePath)).digest('hex')
}

export async function saveProductAngleAnalysis(
  productPath: string,
  input: SceneAngleInput,
  options: {
    source: SceneAngleSource
    model?: string
    imageHash?: string
    tokenUsage?: SceneAngleAnalysis['tokenUsage']
  },
): Promise<ProductAngleAnalysis> {
  const safePath = assertProjectPath(productPath)
  const root = findProjectRoot(safePath)
  if (!root) throw new Error('图2素材不在已扫描的项目目录内')
  const analysis: ProductAngleAnalysis = {
    productPath: safePath,
    ...normalizeSceneAngleInput(input),
    source: options.source,
    model: options.model,
    analyzedAt: new Date().toISOString(),
    imageHash: options.imageHash || await hashProductImage(safePath),
    tokenUsage: options.tokenUsage,
  }

  await queueWrite(root, async () => {
    const store = await readStore(root)
    const { productPath: _productPath, ...stored } = analysis
    store.products[productKey(root, safePath)] = stored
    store.updatedAt = analysis.analyzedAt
    await writeStore(root, store)
  })
  return analysis
}

export async function getProductAngleAnalysis(productPath: string): Promise<ProductAngleAnalysis | undefined> {
  const safePath = assertProjectPath(productPath)
  const root = findProjectRoot(safePath)
  if (!root) return undefined
  const stored = (await readStore(root)).products[productKey(root, safePath)]
  return stored ? { productPath: safePath, ...stored } : undefined
}

export async function getProductAngleAnalyses(productPaths: string[]): Promise<ProductAngleAnalysis[]> {
  if (!productPaths.length) return []
  const grouped = new Map<string, string[]>()
  for (const path of productPaths) {
    const safePath = assertProjectPath(path)
    const root = findProjectRoot(safePath)
    if (!root) continue
    grouped.set(root, [...(grouped.get(root) || []), safePath])
  }

  const results: ProductAngleAnalysis[] = []
  for (const [root, paths] of grouped) {
    const store = await readStore(root)
    for (const path of paths) {
      const stored = store.products[productKey(root, path)]
      if (stored) results.push({ productPath: path, ...stored })
    }
  }
  return results
}

export async function listStoredProductAngles(root: string): Promise<ProductAngleAnalysis[]> {
  const store = await readStore(root)
  return Object.entries(store.products).map(([key, value]) => ({
    productPath: absoluteProductPath(root, key),
    ...value,
  }))
}
