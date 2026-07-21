import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchSceneToProductGroup } from './angleMatches.js'
import { ProductAngleAnalysis } from './productAngles.js'
import { SceneAngleAnalysis } from './sceneAngles.js'

const base = {
  elevation: 0,
  mirrored: false,
  occlusion: 0,
  chairCount: 1,
  reason: 'test',
  source: 'agent' as const,
  analyzedAt: new Date(0).toISOString(),
  imageHash: 'hash',
}

function product(productPath: string, azimuth: number, confidence = 0.95): ProductAngleAnalysis {
  return { productPath, angle: 'front_right', azimuth, confidence, ...base }
}

test('chooses a high-confidence close product angle for automatic preselection', () => {
  const scene: SceneAngleAnalysis = {
    scenePath: '/project/scenes/1.jpg', angle: 'front_right', azimuth: 42, confidence: 0.96, ...base,
  }
  const result = matchSceneToProductGroup(scene, '米白色', [
    product('/project/products/米白色/front.jpg', 0),
    product('/project/products/米白色/right.jpg', 45),
  ])
  assert.equal(result.productPath, '/project/products/米白色/right.jpg')
  assert.equal(result.status, 'auto')
  assert.equal(result.angleDifference, 3)
})

test('does not preselect an unsafe low-confidence match', () => {
  const scene: SceneAngleAnalysis = {
    scenePath: '/project/scenes/1.jpg', angle: 'right', azimuth: 90, confidence: 0.5, ...base,
  }
  const result = matchSceneToProductGroup(scene, '黑色', [
    product('/project/products/黑色/right.jpg', 90, 0.7),
  ])
  assert.equal(result.productPath, null)
  assert.equal(result.status, 'unmatched')
})
