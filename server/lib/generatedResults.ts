import { createHash, randomUUID } from 'node:crypto'
import {
  link,
  mkdir,
  readdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import sharp from 'sharp'
import { assertProjectPath, outputDirFor } from './projectAccess.js'

const MAX_RESULT_BYTES = 40 * 1024 * 1024
const saveQueues = new Map<string, Promise<unknown>>()

export interface SavedGeneratedResult {
  savedPath: string
  version: number
  width: number
  height: number
}

function safeName(value: string, maxLength = 48): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return 'image'
  if (cleaned.length <= maxLength) return cleaned
  const suffix = createHash('sha256').update(cleaned).digest('hex').slice(0, 8)
  return `${cleaned.slice(0, Math.max(1, maxLength - suffix.length - 1))}-${suffix}`
}

export function buildOutputStem(sceneFile: string, productFile: string): string {
  const sceneName = safeName(basename(sceneFile, extname(sceneFile)), 42)
  const productName = safeName(basename(productFile, extname(productFile)), 48)
  return `${sceneName}-${productName}`
}

export function buildOutputGroupName(productFile: string): string {
  const parentName = basename(dirname(productFile))
  return parentName && parentName.toLowerCase() !== 'products'
    ? safeName(parentName, 32)
    : '未分组'
}

export function outputFileName(stem: string, version: number): string {
  return `${stem}${version > 1 ? `-v${version}` : ''}.png`
}

function parseStoredVersion(fileName: string, stem: string): number | null {
  if (fileName === `${stem}.png`) return 1
  if (!fileName.startsWith(`${stem}-v`) || !fileName.endsWith('.png')) return null
  const value = Number(fileName.slice(stem.length + 2, -4))
  return Number.isInteger(value) && value >= 2 ? value : null
}

async function nextAvailableVersion(
  outputDir: string,
  stem: string,
  requestedVersion: number,
): Promise<number> {
  let highest = 0
  for (const fileName of await readdir(outputDir)) {
    const storedVersion = parseStoredVersion(fileName, stem)
    if (storedVersion && storedVersion > highest) highest = storedVersion
  }
  return Math.max(requestedVersion, highest + 1)
}

async function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = saveQueues.get(key) || Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  saveQueues.set(key, current)
  try {
    return await current
  } finally {
    if (saveQueues.get(key) === current) saveQueues.delete(key)
  }
}

export async function saveGeneratedResult(input: {
  image: Buffer
  sceneFile: string
  productFile: string
  requestedVersion?: number
}): Promise<SavedGeneratedResult> {
  if (!input.image.length || input.image.length > MAX_RESULT_BYTES) {
    throw new Error('生成图片大小异常')
  }
  const safeScene = assertProjectPath(input.sceneFile)
  const safeProduct = assertProjectPath(input.productFile)
  const outputDir = join(outputDirFor(safeScene), buildOutputGroupName(safeProduct))
  const stem = buildOutputStem(safeScene, safeProduct)
  const requestedVersion = Number.isInteger(input.requestedVersion)
    ? Math.min(999_999, Math.max(1, input.requestedVersion!))
    : 1
  const queueKey = join(outputDir, stem).toLowerCase()

  return serialize(queueKey, async () => {
    await mkdir(outputDir, { recursive: true })
    const converted = await sharp(input.image)
      .rotate()
      .png()
      .toBuffer({ resolveWithObject: true })
    const width = converted.info.width
    const height = converted.info.height
    if (!width || !height) throw new Error('无法读取生成图片尺寸')

    let version = await nextAvailableVersion(outputDir, stem, requestedVersion)
    const temporaryPath = join(outputDir, `.${stem}.${process.pid}.${randomUUID()}.tmp`)
    await writeFile(temporaryPath, converted.data, { flag: 'wx' })
    try {
      // Creating a hard link publishes the fully written temp file atomically and
      // fails with EEXIST instead of replacing a file created by another process.
      let finalPath: string
      while (true) {
        finalPath = join(outputDir, outputFileName(stem, version))
        try {
          await link(temporaryPath, finalPath)
          break
        } catch (error: any) {
          if (error?.code !== 'EEXIST') throw error
          version += 1
        }
      }
      return { savedPath: finalPath, version, width, height }
    } finally {
      try {
        await unlink(temporaryPath)
      } catch {
        // The immutable final hard link is already published. A locked temp file
        // can be cleaned later and must not turn a successful save into a failure.
      }
    }
  })
}
