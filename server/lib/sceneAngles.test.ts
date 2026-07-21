import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearProjectRootsForTest, registerProjectRoot } from './projectAccess.js'
import {
  angleFromAzimuth,
  getSceneAngleAnalysis,
  normalizeSceneAngleInput,
  saveSceneAngleAnalysis,
} from './sceneAngles.js'

test('keeps strict front separate from visible three-quarter perspective', () => {
  assert.equal(angleFromAzimuth(8), 'front')
  assert.equal(angleFromAzimuth(18), 'front_right')
  assert.equal(angleFromAzimuth(342), 'front_left')
  assert.equal(normalizeSceneAngleInput({ angle: 'front', azimuth: 18 }).angle, 'front_right')
})

let root = ''
let scene = ''

beforeEach(() => {
  clearProjectRootsForTest()
  root = mkdtempSync(join(tmpdir(), 'scene-angle-store-'))
  mkdirSync(join(root, 'scenes'))
  mkdirSync(join(root, 'products'))
  scene = join(root, 'scenes', '001.jpg')
  writeFileSync(scene, 'fake-image-content')
  registerProjectRoot(root)
})

afterEach(() => {
  clearProjectRootsForTest()
  rmSync(root, { recursive: true, force: true })
})

test('normalizes confidence and geometry limits', () => {
  const result = normalizeSceneAngleInput({
    angle: 'right',
    azimuth: 500,
    elevation: -120,
    confidence: 2,
    occlusion: -1,
    chairCount: 1.4,
  })
  assert.equal(result.azimuth, 359.9)
  assert.equal(result.elevation, -90)
  assert.equal(result.confidence, 1)
  assert.equal(result.occlusion, 0)
  assert.equal(result.chairCount, 1)
})

test('persists one idempotent analysis record per scene', async () => {
  const first = await saveSceneAngleAnalysis(scene, {
    angle: 'front', confidence: 0.8, occlusion: 0.1, reason: 'First pass',
  }, { source: 'agent' })
  const second = await saveSceneAngleAnalysis(scene, {
    angle: 'front_right', confidence: 0.9, occlusion: 0.05, reason: 'Reviewed',
  }, { source: 'agent' })
  const saved = await getSceneAngleAnalysis(scene)

  assert.equal(first.scenePath, second.scenePath)
  assert.equal(saved?.angle, 'front_right')
  assert.equal(saved?.reason, 'Reviewed')
  assert.equal(saved?.source, 'agent')
})
