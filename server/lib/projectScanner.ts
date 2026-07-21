import { readdir, stat } from 'fs/promises'
import { extname, join, resolve } from 'path'
import { registerProjectRoot } from './projectAccess.js'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp'])

export interface ProductGroup {
  name: string
  images: string[]
}

export interface ProjectScanResult {
  root: string
  scenes: string[]
  products: string[]
  productGroups: ProductGroup[]
}

function isImage(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filename).toLowerCase())
}

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' })
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export async function scanProject(folderPath: string): Promise<ProjectScanResult> {
  const requestedPath = resolve(folderPath)
  if (!(await isDirectory(requestedPath))) throw new Error('文件夹不存在')

  const root = registerProjectRoot(requestedPath)
  const scenesDir = join(root, 'scenes')
  const productsDir = join(root, 'products')
  const scenes: string[] = []
  const products: string[] = []
  const productGroups: ProductGroup[] = []

  if (await isDirectory(scenesDir)) {
    const entries = await readdir(scenesDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && isImage(entry.name)) scenes.push(join(scenesDir, entry.name))
    }
    scenes.sort(naturalSort)
  }

  if (await isDirectory(productsDir)) {
    const entries = await readdir(productsDir, { withFileTypes: true })
    const folders = entries.filter(entry => entry.isDirectory())
    if (folders.length) {
      for (const folder of folders.sort((a, b) => naturalSort(a.name, b.name))) {
        const groupDir = join(productsDir, folder.name)
        const groupEntries = await readdir(groupDir, { withFileTypes: true })
        const images = groupEntries
          .filter(entry => entry.isFile() && isImage(entry.name))
          .map(entry => join(groupDir, entry.name))
          .sort(naturalSort)
        if (images.length) {
          productGroups.push({ name: folder.name, images })
          products.push(...images)
        }
      }
      for (const entry of entries) {
        if (entry.isFile() && isImage(entry.name)) products.push(join(productsDir, entry.name))
      }
    } else {
      for (const entry of entries) {
        if (entry.isFile() && isImage(entry.name)) products.push(join(productsDir, entry.name))
      }
    }
    products.sort(naturalSort)
  }

  return { root, scenes, products, productGroups }
}
