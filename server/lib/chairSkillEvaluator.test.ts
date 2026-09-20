import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('separates angle and direction accuracy and audits unsafe auto matches', () => {
  const root = mkdtempSync(join(tmpdir(), 'chair-skill-evaluator-'))
  const truthPath = join(root, 'truth.json')
  const predictionPath = join(root, 'predictions.json')
  const evaluatorPath = resolve(process.cwd(), 'skills/chair-angle-matcher/scripts/evaluate-results.mjs')
  const base = {
    angle: 'front_right', azimuth: 20, imageFacingDirection: 'right',
    angleObservability: 'exact', coarseDirection: 'front', confidence: 0.9,
  }
  try {
    writeFileSync(truthPath, JSON.stringify({ cases: [
      { ...base, scenePath: 'wrong-direction.png', footrest: { capability: 'present', state: 'retracted', visibility: 1 } },
      { ...base, scenePath: 'safe-hidden.png', footrest: { capability: 'unknown', state: 'unknown', visibility: 0 } },
    ] }))
    writeFileSync(predictionPath, JSON.stringify({ results: [
      { ...base, scenePath: 'wrong-direction.png', imageFacingDirection: 'left', status: 'auto', footrest: { capability: 'present', state: 'retracted' } },
      { ...base, scenePath: 'safe-hidden.png', status: 'auto', footrestAssumedRetracted: true, footrest: { capability: 'present', state: 'retracted' } },
    ] }))
    const metrics = JSON.parse(execFileSync(process.execPath, [evaluatorPath, truthPath, predictionPath], { encoding: 'utf8' }))
    assert.equal(metrics.angleAccuracy, 1)
    assert.equal(metrics.directionAccuracy, 0.5)
    assert.equal(metrics.autoJointPrecision, 0.5)
    assert.equal(metrics.dangerousAutoMatchCount, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
