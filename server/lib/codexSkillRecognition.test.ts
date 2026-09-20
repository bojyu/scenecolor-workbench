import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeCodexOutput, recognizeProjectAnglesWithCodexSkill } from './codexSkillRecognition.js'

test('normalizes Codex Skill output and enforces conservative workflow gates', () => {
  const results = normalizeCodexOutput({ results: [
    {
      scenePath: 'scenes/clean.png', angle: 'front_right', azimuth: 20,
      imageFacingDirection: 'right', angleObservability: 'exact', coarseDirection: 'front', confidence: 0.93,
      occlusion: 0.1, chairCount: 1, matchable: true, status: 'auto',
      decisiveCue: 'Seat axis and armrest perspective point image-right.', sceneMode: 'single',
      sameModelConfidence: null, instances: [], reclineState: 'unknown', visibleParts: {},
      footrest: { capability: 'present', state: 'retracted', visibility: 1, confidence: 0.98, decisiveCue: 'Stored pad is visible.' },
    },
    {
      scenePath: 'scenes/coarse.png', angle: 'right', azimuth: 90,
      imageFacingDirection: 'right', angleObservability: 'coarse', coarseDirection: 'right', confidence: 0.95,
      occlusion: 0.5, chairCount: 1, matchable: true, status: 'auto',
      decisiveCue: 'Only the side family is visible.', sceneMode: 'single',
      sameModelConfidence: null, instances: [], reclineState: 'unknown', visibleParts: {},
      footrest: { capability: 'unknown', state: 'unknown', visibility: 0.2, confidence: 0.8, decisiveCue: 'Partly hidden.' },
    },
    {
      scenePath: 'scenes/inverted.png', angle: 'front_left', azimuth: 330,
      imageFacingDirection: 'right', angleObservability: 'exact', coarseDirection: 'front', confidence: 0.95,
      occlusion: 0, chairCount: 1, matchable: true, status: 'auto',
      decisiveCue: 'Conflicting fields.', sceneMode: 'single', sameModelConfidence: null,
      instances: [], reclineState: 'unknown', visibleParts: {},
      footrest: { capability: 'present', state: 'retracted', visibility: 1, confidence: 1, decisiveCue: 'Visible.' },
    },
  ] }, ['scenes/clean.png', 'scenes/coarse.png', 'scenes/inverted.png', 'scenes/missing.png'])

  assert.equal(results[0].status, 'auto')
  assert.equal(results[0].matchable, true)
  assert.equal(results[1].status, 'unmatched')
  assert.equal(results[1].matchable, false)
  assert.equal(results[2].angle, 'unknown')
  assert.equal(results[2].status, 'unmatched')
  assert.match(results[2].decisiveCue, /冲突/)
  assert.equal(results[3].angle, 'unknown')
  assert.equal(results[3].status, 'unmatched')
})

test('runs one Codex batch and then applies the trained deterministic matcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-skill-recognition-'))
  const scenePath = join(root, 'scenes', '001.png')
  const productPath = join(root, 'products', '白色', 'front-right.jpg')
  const trainingDir = join(root, '.scenecolor', 'skill-training')
  try {
    await mkdir(join(root, 'scenes'), { recursive: true })
    await mkdir(join(root, 'products', '白色'), { recursive: true })
    await mkdir(trainingDir, { recursive: true })
    await writeFile(scenePath, 'mock')
    await writeFile(productPath, 'mock')
    await writeFile(join(trainingDir, 'product-angle-index.json'), JSON.stringify({
      version: 1,
      clusterToleranceDegrees: 15,
      footrestCapability: 'present',
      groups: ['白色'],
      angles: [{
        key: 'front_right_20_retracted', angle: 'front_right', azimuth: 20,
        imageFacingDirection: 'right', footrestState: 'retracted',
        anchors: { 白色: 'products/白色/front-right.jpg' },
      }],
    }))

    const result = await recognizeProjectAnglesWithCodexSkill({
      root,
      scenes: [scenePath],
      products: [productPath],
      productGroups: [{ name: '白色', images: [productPath] }],
    }, undefined, {
      runtime: { providerId: 'proxy', model: 'gpt-5.6-terra', reasoningEffort: 'low', skillId: 'chair-angle-matcher' },
      runCodex: async (args, prompt) => {
        assert.equal(args.filter(arg => arg === '--image').length, 1)
        assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'gpt-5.6-terra'])
        assert.ok(args.includes('model_provider="proxy"'))
        assert.ok(args.includes('model_reasoning_effort="low"'))
        assert.match(prompt, /chair-angle-matcher/)
        assert.match(prompt, /AUTHORITATIVE OBSERVATION CONTRACT/)
        assert.doesNotMatch(prompt, /front_right_20_retracted/)
        const outputIndex = args.indexOf('--output-last-message')
        await writeFile(args[outputIndex + 1], JSON.stringify({ results: [{
          scenePath: 'scenes/001.png', angle: 'front_right', azimuth: 20,
          imageFacingDirection: 'right', angleObservability: 'exact', coarseDirection: 'front', confidence: 0.96,
          occlusion: 0, chairCount: 1, matchable: true, status: 'auto',
          decisiveCue: 'Seat axis and side panel project image-right.', sceneMode: 'single',
          sameModelConfidence: null, instances: [], reclineState: 'unknown', visibleParts: {},
          footrest: { capability: 'present', state: 'retracted', visibility: 1, confidence: 0.98, decisiveCue: 'Stored pad is visible.' },
        }] }))
        return { stdout: '', stderr: '' }
      },
    })

    const matches = JSON.parse(await readFile(result.matchResultsPath, 'utf8'))
    assert.equal(result.recognition.callsMade, 1)
    assert.equal(result.recognition.providerId, 'proxy')
    assert.equal(result.recognition.reasoningEffort, 'low')
    assert.equal(matches.summary.externalApiCalls, 1)
    assert.equal(matches.matches[0].status, 'auto')
    assert.ok(matches.matches[0].productPath.endsWith('/front-right.jpg'))

    const cached = await recognizeProjectAnglesWithCodexSkill({
      root,
      scenes: [scenePath],
      products: [productPath],
      productGroups: [{ name: '鐧借壊', images: [productPath] }],
    }, undefined, {
      runtime: { providerId: 'proxy', model: 'gpt-5.6-terra', reasoningEffort: 'low', skillId: 'chair-angle-matcher' },
      runCodex: async () => { throw new Error('cache miss') },
    })
    assert.equal(cached.recognition.callsMade, 0)
    assert.equal(cached.recognition.cachedSceneCount, 1)
    assert.equal(matches.matches[0].productPath, 'products/白色/front-right.jpg')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
