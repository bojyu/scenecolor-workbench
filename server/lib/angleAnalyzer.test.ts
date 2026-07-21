import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { ANGLE_PROMPT, analyzeSceneAngleWithModel, parseAngleAnalysis } from './angleAnalyzer.js'
import { clearProjectRootsForTest, registerProjectRoot } from './projectAccess.js'

test('parses a fenced JSON angle response', () => {
  const result = parseAngleAnalysis(`\`\`\`json
  {
    "angle": "front_left",
    "azimuth": 318,
    "elevation": 4,
    "mirrored": false,
    "occlusion": 0.2,
    "confidence": 0.87,
    "chairCount": 1,
    "reason": "Visible chair back and left arm geometry"
  }
  \`\`\``)
  assert.equal(result.angle, 'front_left')
  assert.equal(result.azimuth, 318)
  assert.equal(result.confidence, 0.87)
})

test('rejects unsupported angle labels', () => {
  assert.throws(() => parseAngleAnalysis('{"angle":"diagonal"}'), /不支持的角度分类/)
})

test('uses the image-facing direction convention in model instructions', () => {
  assert.match(ANGLE_PROMPT, /points toward image-right/)
  assert.match(ANGLE_PROMPT, /points toward image-left/)
  assert.doesNotMatch(ANGLE_PROMPT, /chair's own perspective/)
})

test('calls a vision-compatible endpoint exactly once and parses usage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scene-angle-model-'))
  mkdirSync(join(root, 'scenes'))
  mkdirSync(join(root, 'products'))
  const scenePath = join(root, 'scenes', '001.jpg')
  await sharp({
    create: { width: 160, height: 120, channels: 3, background: { r: 220, g: 220, b: 220 } },
  }).jpeg().toFile(scenePath)
  clearProjectRootsForTest()
  registerProjectRoot(root)

  let calls = 0
  const mockServer = createServer((_req, res) => {
    calls += 1
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        angle: 'front_right', azimuth: 46, elevation: 2, mirrored: false,
        occlusion: 0.1, confidence: 0.92, chairCount: 1, reason: 'Mock geometry',
      }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
    }))
  })
  await new Promise<void>(resolve => mockServer.listen(0, '127.0.0.1', resolve))
  const address = mockServer.address()
  if (!address || typeof address === 'string') throw new Error('Mock server failed to start')

  const previousUrl = process.env.ANGLE_API_URL
  const previousModel = process.env.ANGLE_MODEL
  process.env.ANGLE_API_URL = `http://127.0.0.1:${address.port}`
  process.env.ANGLE_MODEL = 'mock-vision-model'
  try {
    const result = await analyzeSceneAngleWithModel(scenePath, 'test-key', new AbortController().signal)
    assert.equal(calls, 1)
    assert.equal(result.analysis.angle, 'front_right')
    assert.equal(result.model, 'mock-vision-model')
    assert.equal(result.tokenUsage?.totalTokens, 130)
  } finally {
    if (previousUrl === undefined) delete process.env.ANGLE_API_URL
    else process.env.ANGLE_API_URL = previousUrl
    if (previousModel === undefined) delete process.env.ANGLE_MODEL
    else process.env.ANGLE_MODEL = previousModel
    await new Promise<void>((resolve, reject) => mockServer.close(error => error ? reject(error) : resolve()))
    clearProjectRootsForTest()
    rmSync(root, { recursive: true, force: true })
  }
})
