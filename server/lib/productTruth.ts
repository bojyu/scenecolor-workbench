import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { ProjectScanResult } from './projectScanner.js'

type AnnotationStatus = 'draft' | 'adjudicated'

export interface ProductTruthAsset {
  assetId: string
  path: string
  sha256: string
  role: 'full_view'
  azimuth: number | null
  angle: string | null
  footrestState: string | null
  partTags: string[]
  annotationStatus: AnnotationStatus
}

export interface ProductTruthPack {
  schemaVersion: 1
  productId: string
  version: 1
  productFamily: string
  colorway: {
    label: string
    mainColorFamily: string | null
    material: string | null
  }
  constraints: {
    footrestCapability: string
    mirrorPolicy: 'review'
  }
  criticalParts: {
    backrest: 'unknown'
    armrest: 'unknown'
    base: 'unknown'
    casters: 'unknown'
    footrest: 'unknown'
  }
  assets: ProductTruthAsset[]
  annotationStatus: AnnotationStatus
}

function projectRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, path)
}

export async function buildDraftProductTruth(project: ProjectScanResult): Promise<{
  path: string
  packs: ProductTruthPack[]
}> {
  const trainingDir = join(project.root, '.scenecolor', 'skill-training')
  let index: any = { footrestCapability: 'unknown', angles: [] }
  try {
    index = JSON.parse(await readFile(join(trainingDir, 'product-angle-index.json'), 'utf8'))
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }

  const factsByAsset = new Map<string, {
    azimuth: number | null
    angle: string | null
    footrestState: string | null
  }>()
  for (const angle of Array.isArray(index.angles) ? index.angles : []) {
    for (const assetPath of Object.values(angle.anchors ?? {})) {
      if (typeof assetPath !== 'string') continue
      factsByAsset.set(assetPath.replace(/\\/g, '/'), {
        azimuth: Number.isFinite(angle.azimuth) ? angle.azimuth : null,
        angle: typeof angle.angle === 'string' ? angle.angle : null,
        footrestState: typeof angle.footrestState === 'string' ? angle.footrestState : null,
      })
    }
  }

  const family = basename(project.root)
  const groups = project.productGroups.length
    ? project.productGroups
    : [{ name: 'unclassified', images: project.products }]
  const packs = await Promise.all(groups.map(async group => {
    const assets = await Promise.all(group.images.map(async absolutePath => {
      const relativePath = projectRelative(project.root, absolutePath)
      const fact = factsByAsset.get(relativePath)
      const hash = createHash('sha256').update(await readFile(absolutePath)).digest('hex')
      return {
        assetId: hash.slice(0, 24),
        path: absolutePath,
        sha256: hash,
        role: 'full_view' as const,
        azimuth: fact?.azimuth ?? null,
        angle: fact?.angle ?? null,
        footrestState: fact?.footrestState ?? null,
        partTags: [],
        annotationStatus: 'draft' as const,
      }
    }))
    return {
      schemaVersion: 1 as const,
      productId: `${family}:${group.name}`,
      version: 1 as const,
      productFamily: family,
      colorway: {
        label: group.name,
        mainColorFamily: null,
        material: null,
      },
      constraints: {
        footrestCapability: typeof index.footrestCapability === 'string' ? index.footrestCapability : 'unknown',
        mirrorPolicy: 'review' as const,
      },
      criticalParts: {
        backrest: 'unknown' as const,
        armrest: 'unknown' as const,
        base: 'unknown' as const,
        casters: 'unknown' as const,
        footrest: 'unknown' as const,
      },
      assets,
      annotationStatus: 'draft' as const,
    }
  }))
  const path = resolve(project.root, '.scenecolor', 'product-truth', 'draft.json')
  await atomicWriteJson(path, {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    source: 'project scan + product-angle-index',
    packs,
  })
  return { path, packs }
}
