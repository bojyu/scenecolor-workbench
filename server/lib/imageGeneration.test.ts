import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildImageGenerationConfig,
  IMAGE_ASPECT_RATIOS,
  normalizeImageAspectRatio,
} from './imageGeneration.js'

test('accepts auto and every supported fixed image aspect ratio', () => {
  for (const ratio of IMAGE_ASPECT_RATIOS) {
    assert.equal(normalizeImageAspectRatio(ratio), ratio)
  }
})

test('defaults missing or unsupported image aspect ratios to auto', () => {
  assert.equal(normalizeImageAspectRatio(undefined), 'auto')
  assert.equal(normalizeImageAspectRatio('freeform'), 'auto')
})

test('serializes auto as the image generation API aspect ratio', () => {
  assert.deepEqual(buildImageGenerationConfig('auto'), {
    image_config: {
      aspect_ratio: 'auto',
    },
  })
})
