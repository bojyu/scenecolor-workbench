import { readFile } from 'node:fs/promises'

type Observability = 'exact' | 'coarse' | 'none'
type CoarseDirection = 'front' | 'right' | 'back' | 'left' | 'unknown'
type Visibility = 'full' | 'partial' | 'hidden' | 'unknown'

export interface ChairCaseQuery {
  angleObservability?: Observability
  coarseDirection?: CoarseDirection
  sceneMode?: 'single' | 'multi_same_model' | 'multi_mixed'
  cropType?: string
  reclineState?: 'upright' | 'reclined' | 'unknown'
  footrest?: { capability?: string; state?: string }
  visibleParts?: Record<string, Visibility>
}

export interface ChairRetrievalCase extends ChairCaseQuery {
  schemaVersion: 2
  caseId: string
  datasetId: string
  scenePath: string
  imageSha256: string | null
  perceptualGroupId?: string | null
  sourceGroupId: string
  split: 'retrieval' | 'validation' | 'blind' | 'regression'
  annotationStatus: 'draft' | 'needs_review' | 'adjudicated' | 'rejected'
  retrievalEligible: boolean
  labelPolicyVersion: string
  [key: string]: unknown
}

export interface RetrievedChairCase {
  case: ChairRetrievalCase
  score: number
  matchedSignals: string[]
}

export interface ChairCaseRetrievalOptions {
  policyId: string
  limit?: number
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function retrievalSafe(item: ChairRetrievalCase, policyId: string): boolean {
  return item.schemaVersion === 2
    && item.split === 'retrieval'
    && item.annotationStatus === 'adjudicated'
    && item.retrievalEligible === true
    && item.labelPolicyVersion === policyId
    && validHash(item.imageSha256)
    && Boolean(item.sourceGroupId)
}

function addExactMatch(
  matchedSignals: string[],
  queryValue: unknown,
  caseValue: unknown,
  field: string,
  weight: number,
): number {
  if (queryValue === undefined || queryValue === 'unknown' || queryValue !== caseValue) return 0
  matchedSignals.push(field)
  return weight
}

export function scoreChairCase(query: ChairCaseQuery, item: ChairRetrievalCase): RetrievedChairCase {
  const matchedSignals: string[] = []
  let score = 0
  score += addExactMatch(matchedSignals, query.coarseDirection, item.coarseDirection, 'coarseDirection', 4)
  score += addExactMatch(matchedSignals, query.angleObservability, item.angleObservability, 'angleObservability', 3)
  score += addExactMatch(matchedSignals, query.sceneMode, item.sceneMode, 'sceneMode', 2)
  score += addExactMatch(matchedSignals, query.cropType, item.cropType, 'cropType', 1)
  score += addExactMatch(matchedSignals, query.reclineState, item.reclineState, 'reclineState', 1)
  score += addExactMatch(matchedSignals, query.footrest?.capability, item.footrest?.capability, 'footrest.capability', 2)
  score += addExactMatch(matchedSignals, query.footrest?.state, item.footrest?.state, 'footrest.state', 2)
  for (const [part, visibility] of Object.entries(query.visibleParts ?? {})) {
    score += addExactMatch(matchedSignals, visibility, item.visibleParts?.[part], `visibleParts.${part}`, 0.25)
  }
  return { case: item, score, matchedSignals }
}

export async function loadChairCaseCorpus(corpusPath: string): Promise<ChairRetrievalCase[]> {
  const content = await readFile(corpusPath, 'utf8')
  return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as ChairRetrievalCase
    } catch (error) {
      throw new Error(`Invalid chair case JSONL at line ${index + 1}: ${String(error)}`)
    }
  })
}

export async function retrieveChairCases(
  corpusPath: string,
  query: ChairCaseQuery,
  options: ChairCaseRetrievalOptions,
): Promise<RetrievedChairCase[]> {
  const limit = Math.max(1, Math.min(20, options.limit ?? 4))
  const cases = (await loadChairCaseCorpus(corpusPath)).filter(item => retrievalSafe(item, options.policyId))
  const bestBySourceGroup = new Map<string, RetrievedChairCase>()
  for (const item of cases) {
    const scored = scoreChairCase(query, item)
    const group = item.perceptualGroupId || item.sourceGroupId
    const current = bestBySourceGroup.get(group)
    if (!current || scored.score > current.score || (scored.score === current.score && item.caseId < current.case.caseId)) {
      bestBySourceGroup.set(group, scored)
    }
  }
  return [...bestBySourceGroup.values()]
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.case.caseId.localeCompare(right.case.caseId))
    .slice(0, limit)
}
