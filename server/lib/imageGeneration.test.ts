import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildImageGenerationConfig,
  IMAGE_ASPECT_RATIOS,
  imageAspectRatiosMatch,
  normalizeImageAspectRatio,
  normalizeImageGenerationModel,
  normalizeImageResolution,
  resolveDisplayImageDimensions,
  resolveGptImage2AutoGeometry,
  resolveRelayImageModel,
  validateImageOutputGeometry,
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

test('keeps relay Auto behavior for Nano Banana', () => {
  assert.deepEqual(buildImageGenerationConfig('auto', '2K'), {
    image_config: {
      aspect_ratio: 'auto',
      image_size: '2K',
    },
  })
})

test('turns Image 2 Auto into an explicit source ratio and canvas size', () => {
  assert.deepEqual(buildImageGenerationConfig('auto', '2K', {
    model: 'gpt-image-2',
    sourceDimensions: { width: 2048, height: 1536 },
  }), {
    image_config: {
      aspect_ratio: '4:3',
      image_size: '2K',
    },
    size: '2048x1536',
  })

  assert.deepEqual(buildImageGenerationConfig('auto', '2K', {
    model: 'gpt-image-2',
    sourceDimensions: { width: 1536, height: 2048 },
  }), {
    image_config: {
      aspect_ratio: '3:4',
      image_size: '2K',
    },
    size: '1536x2048',
  })
})

test('does not let source dimensions override a fixed Image 2 ratio', () => {
  assert.deepEqual(buildImageGenerationConfig('16:9', '2K', {
    model: 'gpt-image-2',
    sourceDimensions: { width: 2048, height: 1536 },
  }), {
    image_config: {
      aspect_ratio: '16:9',
      image_size: '2K',
    },
  })
})

test('fails closed when Image 2 Auto cannot read Image 1 dimensions', () => {
  assert.throws(
    () => buildImageGenerationConfig('auto', '2K', { model: 'gpt-image-2' }),
    /无法读取图1尺寸/,
  )
})

test('creates legal Image 2 canvases while preserving common source ratios exactly', () => {
  const cases = [
    { source: { width: 1920, height: 1080 }, resolution: '1K' as const },
    { source: { width: 2048, height: 1536 }, resolution: '2K' as const },
    { source: { width: 3024, height: 4032 }, resolution: '4K' as const },
    { source: { width: 1000, height: 1000 }, resolution: '4K' as const },
  ]

  for (const { source, resolution } of cases) {
    const geometry = resolveGptImage2AutoGeometry(source, resolution)
    assert.equal(geometry.width % 16, 0)
    assert.equal(geometry.height % 16, 0)
    assert.ok(Math.max(geometry.width, geometry.height) <= 3840)
    assert.ok(geometry.width * geometry.height >= 655_360)
    assert.ok(geometry.width * geometry.height <= 8_294_400)
    assert.equal(geometry.width * source.height, geometry.height * source.width)
    assert.equal(geometry.exact, true)
  }

  assert.deepEqual(resolveGptImage2AutoGeometry({ width: 1920, height: 1080 }, '1K'), {
    width: 1280,
    height: 720,
    aspectRatio: '16:9',
    size: '1280x720',
    exact: true,
  })
  assert.deepEqual(resolveGptImage2AutoGeometry({ width: 1000, height: 1000 }, '4K'), {
    width: 2880,
    height: 2880,
    aspectRatio: '1:1',
    size: '2880x2880',
    exact: true,
  })
})

test('approximates non-aligned source ratios within one tenth of one percent', () => {
  const source = { width: 4096, height: 3373 }
  const geometry = resolveGptImage2AutoGeometry(source, '2K')
  assert.equal(geometry.exact, false)
  assert.ok(imageAspectRatiosMatch(source, geometry))
})

test('rejects source ratios that Image 2 cannot represent', () => {
  assert.throws(
    () => resolveGptImage2AutoGeometry({ width: 4000, height: 1000 }, '2K'),
    /超过 3:1/,
  )
})

test('uses EXIF-oriented display dimensions before raw encoded dimensions', () => {
  assert.deepEqual(resolveDisplayImageDimensions({
    width: 4032,
    height: 3024,
    autoOrient: { width: 3024, height: 4032 },
  }), { width: 3024, height: 4032 })
  assert.deepEqual(resolveDisplayImageDimensions({
    width: 2048,
    height: 1536,
  }), { width: 2048, height: 1536 })
})

test('detects a provider output ratio mismatch', () => {
  assert.equal(
    imageAspectRatiosMatch({ width: 2048, height: 1536 }, { width: 1024, height: 1024 }),
    false,
  )
  assert.equal(
    imageAspectRatiosMatch({ width: 2048, height: 1536 }, { width: 1024, height: 768 }),
    true,
  )
})

test('accepts the source ratio and reports a provider size that needs normalization', () => {
  assert.deepEqual(
    validateImageOutputGeometry(
      { width: 2048, height: 1536 },
      { width: 1024, height: 768 },
    ),
    {
      ratioMatches: true,
      sizeMatches: false,
      valid: true,
    },
  )
  assert.deepEqual(
    validateImageOutputGeometry(
      { width: 2048, height: 1536 },
      { width: 2048, height: 1536 },
    ),
    {
      ratioMatches: true,
      sizeMatches: true,
      valid: true,
    },
  )
})

test('normalizes the small Image 2 canvas jitter seen in real 2K responses', () => {
  assert.deepEqual(
    validateImageOutputGeometry(
      { width: 1664, height: 2080 },
      { width: 1123, height: 1400 },
    ),
    {
      ratioMatches: true,
      sizeMatches: false,
      valid: true,
    },
  )

  assert.deepEqual(
    validateImageOutputGeometry(
      { width: 1664, height: 2080 },
      { width: 1140, height: 1400 },
    ),
    {
      ratioMatches: false,
      sizeMatches: false,
      valid: false,
    },
  )
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
