import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import sharp from 'sharp'
import {
  prepareGenerationInput,
  prepareGenerationInputs,
  RELAY_INPUT_AGGREGATE_MAX_BYTES,
  RELAY_INPUT_PER_FILE_MAX_BYTES,
} from './generationInput.js'

test('generation input bounds a large source while preserving display orientation', async () => {
  const source = await sharp({
    create: {
      width: 3600,
      height: 5400,
      channels: 3,
      background: '#7f4529',
    },
  }).png().toBuffer()
  const prepared = await prepareGenerationInput(source, 'image/png')
  const encoded = Buffer.from(prepared.dataUri.split(',')[1], 'base64')
  const metadata = await sharp(encoded).metadata()

  assert.equal(prepared.optimized, true)
  assert.ok(prepared.transmittedBytes < 2_500_000)
  assert.equal(Math.max(metadata.width || 0, metadata.height || 0), 2048)
  assert.equal(metadata.format, 'jpeg')
})

test('small normalized JPEG can pass through without needless recompression', async () => {
  const source = await sharp({
    create: {
      width: 640,
      height: 480,
      channels: 3,
      background: '#d8d8d8',
    },
  }).jpeg({ quality: 80 }).toBuffer()
  const prepared = await prepareGenerationInput(source, 'image/jpeg')

  assert.equal(prepared.optimized, false)
  assert.equal(prepared.transmittedBytes, source.length)
  assert.deepEqual(Buffer.from(prepared.dataUri.split(',')[1], 'base64'), source)
})

test('multiple noisy references are bounded by per-file and aggregate relay budgets', async () => {
  const width = 1800
  const height = 1800
  const source = await sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer()
  const prepared = await prepareGenerationInputs(Array.from({ length: 4 }, () => ({
    source,
    mime: 'image/jpeg',
  })))

  assert.equal(prepared.length, 4)
  assert.ok(prepared.every(item => item.transmittedBytes <= RELAY_INPUT_PER_FILE_MAX_BYTES))
  assert.ok(
    prepared.reduce((total, item) => total + item.transmittedBytes, 0)
      <= RELAY_INPUT_AGGREGATE_MAX_BYTES,
  )
})
