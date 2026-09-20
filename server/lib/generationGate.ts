import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { findProjectRoot } from './projectAccess.js'
import { scanProject } from './projectScanner.js'
import { loadChairSkillResults } from './skillResults.js'

export class GenerationGateError extends Error {
  readonly statusCode = 422
  readonly code = 'review_gate'

  constructor(message: string) {
    super(message)
    this.name = 'GenerationGateError'
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function hasCurrentSkillArtifacts(root: string): Promise<boolean> {
  const trainingDir = join(root, '.scenecolor', 'skill-training')
  if (await exists(join(trainingDir, 'current-run.json'))) return true
  return await exists(join(trainingDir, 'scene-angle-results.json'))
    && await exists(join(trainingDir, 'footrest-matching-results.json'))
}

export async function assertSkillGenerationAllowed(
  scenePath: string,
  productPath: string,
  skillId = 'chair-angle-matcher',
): Promise<void> {
  if (scenePath.startsWith('data:image/') || productPath.startsWith('data:image/')) return

  const sceneRoot = findProjectRoot(scenePath)
  const productRoot = findProjectRoot(productPath)
  if (!sceneRoot || !productRoot || resolve(sceneRoot) !== resolve(productRoot)) return
  if (!await hasCurrentSkillArtifacts(sceneRoot)) return

  const project = await scanProject(sceneRoot)
  const results = await loadChairSkillResults(project, skillId)
  const scene = results.sceneResults.find(item => resolve(item.scenePath) === resolve(scenePath))
  if (!scene) return

  const matchingDecision = results.matches.find(item =>
    resolve(item.scenePath) === resolve(scenePath)
    && item.productPath
    && resolve(item.productPath) === resolve(productPath))
  if (matchingDecision?.status === 'auto') return

  const confirmedProducts = results.learnedSelections[scene.scenePath] ?? []
  if (confirmedProducts.some(item => resolve(item) === resolve(productPath))) return

  const reason = matchingDecision?.status === 'review'
    ? '该参考图仍处于待复核状态'
    : '该参考图不是当前自动匹配结果'
  throw new GenerationGateError(`${reason}，请先在工作台人工确认参考图后再生成。`)
}
