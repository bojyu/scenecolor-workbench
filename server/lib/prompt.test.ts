import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildGenerationPrompt } from './prompt.js'

test('keeps the base scene-preservation rules when adding custom instructions', () => {
  const prompt = buildGenerationPrompt('Make the fabric slightly warmer.')
  assert.match(prompt, /Do not change the scene/)
  assert.match(prompt, /Additional user instructions:/)
  assert.match(prompt, /Make the fabric slightly warmer\./)
})

test('adds exact source dimensions when metadata is available', () => {
  const prompt = buildGenerationPrompt(undefined, { width: 2048, height: 1536 }, { aspectRatio: 'auto' })
  assert.match(prompt, /2048×1536/)
  assert.match(prompt, /Image 1's original aspect ratio/)
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
