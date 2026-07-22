import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  angleFromPolicyAzimuth,
  directionForAngle,
  loadChairDecisionPolicySync,
  validateChairDecisionPolicy,
} from './chairAnglePolicy.js'

test('uses one policy for all semantic angle boundaries and directions', () => {
  const policy = loadChairDecisionPolicySync()
  const cases = [
    [0, 'front'], [10, 'front'], [10.001, 'front_right'], [79.999, 'front_right'],
    [80, 'right'], [100, 'right'], [100.001, 'back_right'], [169.999, 'back_right'],
    [170, 'back'], [190, 'back'], [190.001, 'back_left'], [259.999, 'back_left'],
    [260, 'left'], [280, 'left'], [280.001, 'front_left'], [349.999, 'front_left'],
    [350, 'front'], [359.999, 'front'], [360, 'front'], [-10, 'front'],
  ] as const
  for (const [azimuth, angle] of cases) assert.equal(angleFromPolicyAzimuth(azimuth, policy), angle)
  assert.equal(directionForAngle('front_right', policy), 'right')
  assert.equal(directionForAngle('front_left', policy), 'left')
  assert.equal(directionForAngle('back', policy), 'center')
})

test('rejects policy gaps and overlaps at semantic boundaries', () => {
  const policy = loadChairDecisionPolicySync()
  const broken = structuredClone(policy)
  broken.angleRanges.find(item => item.angle === 'front')!.ranges[1][1] = 9
  assert.throws(() => validateChairDecisionPolicy(broken), /gap or overlap/)
})
