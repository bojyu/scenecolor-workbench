import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildGenerationPrompt } from './prompt.js'

test('keeps the base scene-preservation rules when adding custom instructions', () => {
  const prompt = buildGenerationPrompt('Make the fabric slightly warmer.')
  assert.match(prompt, /Do not change the scene/)
  assert.match(prompt, /Additional user instructions:/)
  assert.match(prompt, /Make the fabric slightly warmer\./)
})

test('describes the source ratio and explicit Image 2 Auto canvas without conflating their pixels', () => {
  const prompt = buildGenerationPrompt(undefined, { width: 4000, height: 3000 }, {
    aspectRatio: 'auto',
    sourceAspectRatio: '4:3',
    outputDimensions: { width: 2048, height: 1536 },
  })
  assert.match(prompt, /width-to-height ratio \(4:3; source 4000×3000\)/)
  assert.match(prompt, /requested output canvas is exactly 2048×1536/)
  assert.match(prompt, /Do not crop, pad, stretch, rotate, or reframe/)
})

test('uses a fixed output ratio without requiring the source dimensions', () => {
  const prompt = buildGenerationPrompt(undefined, { width: 2048, height: 1536 }, { aspectRatio: '16:9' })
  assert.match(prompt, /16:9 aspect ratio/)
  assert.doesNotMatch(prompt, /2048×1536/)
})

test('adds safe multi-view instructions for supporting references', () => {
  const prompt = buildGenerationPrompt(undefined, undefined, { supportingReferenceCount: 2 })
  assert.match(prompt, /Images 3 through 4 are supporting views/)
  assert.match(prompt, /preserve each chair's original instance angle/)
  assert.match(prompt, /Do not average, merge, or rotate/)
})
