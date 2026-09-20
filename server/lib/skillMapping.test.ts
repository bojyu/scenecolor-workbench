import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SkillMatchResult } from '../../src/types/index.js'
import { buildSkillMapping } from '../../src/lib/skillMapping.js'

function match(
  scenePath: string,
  productPath: string | null,
  status: SkillMatchResult['status'],
): SkillMatchResult {
  return {
    scenePath,
    groupName: 'black',
    productPath,
    supportingReferences: [],
    angle: 'front',
    azimuth: 0,
    footrestCapability: 'unknown',
    observedFootrestCapability: 'unknown',
    footrestState: 'unknown',
    observedFootrestState: 'unknown',
    footrestAssumedRetracted: false,
    capabilityFallback: false,
    anchorKey: 'front_0_unknown',
    mirrored: false,
    angleDifference: 0,
    status,
    reason: status,
    referenceMode: 'single',
  }
}

test('keeps review references visible while excluding unmatched results', () => {
  const mapping = buildSkillMapping([
    match('scene-1.jpg', 'auto.jpg', 'auto'),
    match('scene-1.jpg', 'review.jpg', 'review'),
    match('scene-1.jpg', 'unmatched.jpg', 'unmatched'),
  ])
  assert.deepEqual([...mapping.get('scene-1.jpg') ?? []], ['auto.jpg', 'review.jpg'])
})

test('exact learned selections override matcher suggestions', () => {
  const mapping = buildSkillMapping(
    [match('scene-1.jpg', 'review.jpg', 'review')],
    { 'scene-1.jpg': ['human-selected.jpg'] },
  )
  assert.deepEqual([...mapping.get('scene-1.jpg') ?? []], ['human-selected.jpg'])

  const cleared = buildSkillMapping(
    [match('scene-1.jpg', 'review.jpg', 'review')],
    { 'scene-1.jpg': [] },
  )
  assert.equal(cleared.has('scene-1.jpg'), false)
})
