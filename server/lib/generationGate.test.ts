import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertSkillGenerationAllowed, GenerationGateError } from './generationGate.js'
import { clearProjectRootsForTest } from './projectAccess.js'
import { scanProject } from './projectScanner.js'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

test('blocks review matches until the exact scene selection is persisted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'generation-review-gate-'))
  const scenePath = join(root, 'scenes', '001.jpg')
  const productPath = join(root, 'products', 'white', 'reference.jpg')
  const trainingDir = join(root, '.scenecolor', 'skill-training')
  const corpusDir = join(root, '.scenecolor', 'case-corpus')
  try {
    await mkdir(join(root, 'scenes'), { recursive: true })
    await mkdir(join(root, 'products', 'white'), { recursive: true })
    await mkdir(trainingDir, { recursive: true })
    await mkdir(corpusDir, { recursive: true })
    await writeFile(scenePath, 'scene-review-gate')
    await writeFile(productPath, 'product-review-gate')
    await writeFile(join(trainingDir, 'scene-angle-results.json'), JSON.stringify({
      results: [{
        scenePath: 'scenes/001.jpg',
        angle: 'front_right',
        azimuth: 20,
        confidence: 0.9,
        occlusion: 0,
        chairCount: 1,
        matchable: true,
        status: 'review',
        decisiveCue: 'review',
        sceneMode: 'single',
        footrest: {
          capability: 'present',
          state: 'retracted',
          visibility: 1,
          confidence: 1,
          decisiveCue: 'visible',
        },
      }],
    }))
    await writeFile(join(trainingDir, 'footrest-matching-results.json'), JSON.stringify({
      matches: [{
        scenePath: 'scenes/001.jpg',
        colorGroup: 'white',
        productPath: 'products/white/reference.jpg',
        angle: 'front_right',
        azimuth: 20,
        footrestCapability: 'present',
        footrestState: 'retracted',
        anchorKey: 'front_right_20_retracted',
        mirrored: false,
        angleDifference: 0,
        status: 'review',
        reason: 'requires confirmation',
      }],
    }))
    await scanProject(root)

    await assert.rejects(
      () => assertSkillGenerationAllowed(scenePath, productPath),
      (error: unknown) => error instanceof GenerationGateError && error.code === 'review_gate',
    )

    await writeFile(join(corpusDir, 'reference-cases.jsonl'), `${JSON.stringify({
      caseId: 'exact-confirmation',
      sceneImageSha256: sha256('scene-review-gate'),
      angle: 'front_right',
      sceneMode: 'single',
      footrest: { state: 'retracted' },
      selectedProducts: [{ imageSha256: sha256('product-review-gate') }],
      updatedAt: '2026-07-24T00:00:00.000Z',
    })}\n`)
    await assert.doesNotReject(() => assertSkillGenerationAllowed(scenePath, productPath))

    await writeFile(join(corpusDir, 'reference-cases.jsonl'), `${JSON.stringify({
      caseId: 'stale-confirmation',
      sceneImageSha256: sha256('scene-review-gate'),
      angle: 'front_left',
      sceneMode: 'single',
      footrest: { state: 'retracted' },
      selectedProducts: [{ imageSha256: sha256('product-review-gate') }],
      updatedAt: '2026-07-24T00:00:00.000Z',
    })}\n`)
    await assert.rejects(() => assertSkillGenerationAllowed(scenePath, productPath), GenerationGateError)
  } finally {
    clearProjectRootsForTest()
    await rm(root, { recursive: true, force: true })
  }
})
