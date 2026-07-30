import type { SkillMatchResult } from '../types'

/**
 * Review matches remain visible so the user can inspect them. The generation
 * gate, not the workbench selection, is responsible for requiring confirmation.
 */
export function buildSkillMapping(
  matches: SkillMatchResult[],
  learnedSelections?: Record<string, string[]>,
): Map<string, Set<string>> {
  const next = new Map<string, Set<string>>()
  for (const match of matches) {
    if (!match.productPath || match.status === 'unmatched') continue
    const selected = next.get(match.scenePath) || new Set<string>()
    selected.add(match.productPath)
    next.set(match.scenePath, selected)
  }
  for (const [scenePath, productPaths] of Object.entries(learnedSelections ?? {})) {
    if (productPaths.length) next.set(scenePath, new Set(productPaths))
    else next.delete(scenePath)
  }
  return next
}
