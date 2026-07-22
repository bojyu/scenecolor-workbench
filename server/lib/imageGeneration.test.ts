import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildImageGenerationConfig,
  IMAGE_ASPECT_RATIOS,
  normalizeImageAspectRatio,
  normalizeImageGenerationModel,
  normalizeImageResolution,
  resolveRelayImageModel,
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

test('serializes aspect ratio and native resolution for the relay API', () => {
  assert.deepEqual(buildImageGenerationConfig('auto', '2K'), {
    image_config: {
      aspect_ratio: 'auto',
      image_size: '2K',
    },
  })
})

test('normalizes the two supported image models and resolution tiers', () => {
  assert.equal(normalizeImageGenerationModel('gpt-image-2'), 'gpt-image-2')
  assert.equal(normalizeImageGenerationModel('unknown'), 'nano-banana-2')
  assert.equal(normalizeImageResolution('2k'), '2K')
  assert.equal(normalizeImageResolution('8K'), '4K')
})

test('routes Nano Banana 2 to resolution-specific slugs and keeps Image 2 stable', () => {
  assert.equal(resolveRelayImageModel('nano-banana-2', '1K'), 'gemini-3.1-flash-image-preview')
  assert.equal(resolveRelayImageModel('nano-banana-2', '2K'), 'gemini-3.1-flash-image-preview-2k')
  assert.equal(resolveRelayImageModel('nano-banana-2', '4K'), 'gemini-3.1-flash-image-preview-4k')
  assert.equal(resolveRelayImageModel('gpt-image-2', '4K'), 'gpt-image-2')
})
