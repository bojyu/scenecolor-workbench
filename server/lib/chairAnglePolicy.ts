import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export type SemanticAngle = 'front' | 'front_right' | 'right' | 'back_right' | 'back' | 'back_left' | 'left' | 'front_left'
export type ImageFacingDirection = 'left' | 'right' | 'center'
export type WorkflowStatus = 'auto' | 'review' | 'unmatched'

type RangeTuple = [number, number, boolean, boolean]

export interface ChairDecisionPolicy {
  version: number
  policyId: string
  angleRanges: Array<{ angle: SemanticAngle; ranges: RangeTuple[]; direction: ImageFacingDirection }>
  autoThresholds: {
    minAngleConfidence: number
    maxOcclusion: number
    minFootrestConfidence: number
    minVisibleFootrest: number
  }
  anchorSelection: {
    requireDirectionMatch: boolean
    allowSemanticBoundaryCrossing: boolean
  }
  multiView: {
    minInstances: number
    minSameModelConfidence: number
    minInstanceConfidence: number
    primaryAnglePreference: SemanticAngle[]
    status: WorkflowStatus
  }
}

const DEFAULT_POLICY_PATH = resolve(process.cwd(), 'skills/chair-angle-matcher/references/decision-policy.json')
const SEMANTIC_ANGLES = new Set<SemanticAngle>([
  'front', 'front_right', 'right', 'back_right', 'back', 'back_left', 'left', 'front_left',
])

function assertProbability(value: unknown, field: string): void {
  if (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1) {
    throw new Error(`Angle decision policy ${field} must be in the range 0..1`)
  }
}

function rangeContains(range: RangeTuple, azimuth: number): boolean {
  const [min, max, includeMin, includeMax] = range
  return (includeMin ? azimuth >= min : azimuth > min) && (includeMax ? azimuth <= max : azimuth < max)
}

export function validateChairDecisionPolicy(raw: unknown): ChairDecisionPolicy {
  if (!raw || typeof raw !== 'object') throw new Error('Angle decision policy must be an object')
  const policy = raw as ChairDecisionPolicy
  if (!Number.isInteger(policy.version) || !policy.policyId || !Array.isArray(policy.angleRanges)) {
    throw new Error('Angle decision policy requires version, policyId, and angleRanges')
  }
  const angles = new Set<SemanticAngle>()
  const boundaries = new Set<number>([0, 360])
  for (const entry of policy.angleRanges) {
    if (!SEMANTIC_ANGLES.has(entry?.angle) || !['left', 'right', 'center'].includes(entry.direction)
      || !Array.isArray(entry.ranges) || !entry.ranges.length) {
      throw new Error('Angle decision policy contains an invalid angle entry')
    }
    if (angles.has(entry.angle)) throw new Error(`Angle decision policy duplicates ${entry.angle}`)
    angles.add(entry.angle)
    for (const range of entry.ranges) {
      if (!Array.isArray(range) || range.length !== 4
        || !Number.isFinite(range[0]) || !Number.isFinite(range[1])
        || typeof range[2] !== 'boolean' || typeof range[3] !== 'boolean'
        || range[0] < 0 || range[1] > 360 || range[0] > range[1]) {
        throw new Error(`Angle decision policy ${entry.angle} contains an invalid range`)
      }
      boundaries.add(range[0])
      boundaries.add(range[1])
    }
  }
  if (angles.size !== SEMANTIC_ANGLES.size) throw new Error('Angle decision policy must cover all eight semantic angles')
  for (const boundary of boundaries) for (const offset of [-0.000001, 0, 0.000001]) {
    const azimuth = normalizeCircularAzimuth(boundary + offset)
    const rangeCount = policy.angleRanges.reduce(
      (count, entry) => count + entry.ranges.filter(range => rangeContains(range, azimuth)).length,
      0,
    )
    if (rangeCount !== 1) throw new Error(`Angle decision policy has a gap or overlap at ${azimuth}`)
  }
  assertProbability(policy.autoThresholds?.minAngleConfidence, 'minAngleConfidence')
  assertProbability(policy.autoThresholds?.maxOcclusion, 'maxOcclusion')
  assertProbability(policy.autoThresholds?.minFootrestConfidence, 'minFootrestConfidence')
  assertProbability(policy.autoThresholds?.minVisibleFootrest, 'minVisibleFootrest')
  assertProbability(policy.multiView?.minSameModelConfidence, 'minSameModelConfidence')
  assertProbability(policy.multiView?.minInstanceConfidence, 'minInstanceConfidence')
  if (typeof policy.anchorSelection?.requireDirectionMatch !== 'boolean'
    || typeof policy.anchorSelection?.allowSemanticBoundaryCrossing !== 'boolean') {
    throw new Error('Angle decision policy anchorSelection flags must be booleans')
  }
  if (!Number.isInteger(policy.multiView?.minInstances) || policy.multiView.minInstances < 2
    || !['auto', 'review', 'unmatched'].includes(policy.multiView?.status)
    || !Array.isArray(policy.multiView?.primaryAnglePreference)
    || !policy.multiView.primaryAnglePreference.length
    || policy.multiView.primaryAnglePreference.some(angle => !SEMANTIC_ANGLES.has(angle))) {
    throw new Error('Angle decision policy multiView configuration is invalid')
  }
  return policy
}

export function loadChairDecisionPolicySync(path = DEFAULT_POLICY_PATH): ChairDecisionPolicy {
  return validateChairDecisionPolicy(JSON.parse(readFileSync(path, 'utf8')))
}

export async function loadChairDecisionPolicy(path = DEFAULT_POLICY_PATH): Promise<ChairDecisionPolicy> {
  return validateChairDecisionPolicy(JSON.parse(await readFile(path, 'utf8')))
}

export function normalizeCircularAzimuth(value: number): number {
  return ((value % 360) + 360) % 360
}

export function angleFromPolicyAzimuth(value: number, policy: ChairDecisionPolicy): SemanticAngle {
  const azimuth = normalizeCircularAzimuth(value)
  for (const entry of policy.angleRanges) {
    if (entry.ranges.some(range => rangeContains(range, azimuth))) return entry.angle
  }
  throw new Error(`Azimuth ${azimuth} does not fall into any configured angle range`)
}

export function directionForAngle(
  angle: SemanticAngle | 'multiple' | 'unknown',
  policy: ChairDecisionPolicy,
): ImageFacingDirection | 'multiple' | 'unknown' {
  if (angle === 'multiple' || angle === 'unknown') return angle
  const entry = policy.angleRanges.find(item => item.angle === angle)
  if (!entry) throw new Error(`Angle decision policy does not define ${angle}`)
  return entry.direction
}
