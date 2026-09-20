import { access, readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { ProjectScanResult } from './projectScanner.js'

interface ProductAngleAnchor {
  anchors?: Record<string, string>
}

export interface ProductAngleIndex {
  groups?: string[]
  angles?: ProductAngleAnchor[]
  [key: string]: unknown
}

export interface ResolvedProductAngleIndex {
  path: string
  index: ProductAngleIndex
  anchorCount: number
}

function pathKey(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function normalizedRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '')
}

async function existingRunIndexes(projectRoot: string): Promise<string[]> {
  const runsDir = join(projectRoot, '.scenecolor', 'runs')
  try {
    const entries = await readdir(runsDir, { withFileTypes: true })
    const candidates = await Promise.all(entries
      .filter(entry => entry.isDirectory())
      .map(async entry => {
        const path = join(runsDir, entry.name, 'product-angle-index.json')
        try {
          await access(path)
          return { path, modifiedAt: (await stat(path)).mtimeMs }
        } catch {
          return null
        }
      }))
    return candidates
      .filter((item): item is { path: string; modifiedAt: number } => Boolean(item))
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .map(item => item.path)
  } catch {
    return []
  }
}

async function readCompatibleIndex(
  path: string,
  productPaths: Set<string>,
): Promise<ResolvedProductAngleIndex | null> {
  try {
    const index = JSON.parse(await readFile(path, 'utf8')) as ProductAngleIndex
    if (!Array.isArray(index.groups) || !index.groups.length || !Array.isArray(index.angles) || !index.angles.length) {
      return null
    }
    const anchorEntries = index.angles.flatMap(angle =>
      Object.entries(angle.anchors ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
    if (!anchorEntries.length) return null
    if (anchorEntries.some(([, anchorPath]) => !productPaths.has(normalizedRelativePath(anchorPath)))) return null
    const anchoredGroups = new Set(anchorEntries.map(([group]) => group))
    if (index.groups.some(group => !anchoredGroups.has(group))) return null
    return { path, index, anchorCount: anchorEntries.length }
  } catch {
    return null
  }
}

/**
 * A product angle index is project data, not a reusable cross-SKU Skill rule.
 * Only indexes whose every anchor resolves to a product in the current scan are
 * eligible. This prevents a valid angle decision from selecting another SKU's
 * filenames.
 */
export async function resolveCompatibleProductAngleIndex(
  project: ProjectScanResult,
  trainingDir: string,
  skillRoot: string,
): Promise<ResolvedProductAngleIndex> {
  const productPaths = new Set(project.products.map(path => pathKey(project.root, path)))
  const candidates = [
    join(trainingDir, 'product-angle-index.json'),
    join(project.root, '.scenecolor', 'product-angle-index.json'),
    ...await existingRunIndexes(project.root),
    join(skillRoot, 'references', 'product-angle-index.json'),
  ]
  for (const path of [...new Set(candidates)]) {
    const resolved = await readCompatibleIndex(path, productPaths)
    if (resolved) return resolved
  }
  throw new Error(
    '当前项目缺少可用的产品角度索引；现有索引引用的是其他产品素材，已停止错误匹配。请先为当前 products 建立产品角度索引。',
  )
}
