import { isAbsolute, join, relative, resolve } from 'path'
import { realpathSync } from 'fs'

const projectRoots = new Set<string>()

export function registerProjectRoot(rootPath: string): string {
  const root = realpathSync(resolve(rootPath))
  projectRoots.add(root)
  return root
}

export function isPathInside(rootPath: string, targetPath: string): boolean {
  const root = resolve(rootPath)
  const target = resolve(targetPath)
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function findProjectRoot(targetPath: string): string | null {
  let canonicalTarget: string
  try {
    canonicalTarget = realpathSync(resolve(targetPath))
  } catch {
    canonicalTarget = resolve(targetPath)
  }
  for (const root of projectRoots) {
    if (isPathInside(root, canonicalTarget)) return root
  }
  return null
}

export function assertProjectPath(targetPath: string): string {
  const resolved = realpathSync(resolve(targetPath))
  if (!findProjectRoot(resolved)) {
    throw new Error('该文件不在已扫描的项目目录内')
  }
  return resolved
}

export function outputDirFor(scenePath: string): string {
  const root = findProjectRoot(scenePath)
  if (!root) throw new Error('场景图不在已扫描的项目目录内')
  return join(root, '套版输出')
}

export function clearProjectRootsForTest(): void {
  projectRoots.clear()
}
