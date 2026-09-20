import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { verifyGenerationAttempt, validateVerificationVerdict } from './chairVerifier.js'
import { recordGenerationAttempt } from './generationAttempts.js'
import type { CodexRuntimeSelection } from './codexRuntime.js'
import { clearProjectRootsForTest } from './projectAccess.js'

const runtime: CodexRuntimeSelection = {
  providerId: 'codex',
  model: 'test-model',
  reasoningEffort: 'medium',
  skillId: 'chair-angle-matcher',
}

test('rejects a verifier verdict whose route conflicts with its issues', () => {
  assert.throws(() => validateVerificationVerdict({
    schemaVersion: '1.0',
    taskId: 'task',
    verdict: 'pass',
    confidence: 0.9,
    summary: 'A major structure error exists.',
    issues: [{
      id: 'issue-1',
      category: 'product_identity',
      severity: 'critical',
      scope: 'global',
      action: 'regenerate',
      confidence: 0.95,
      evidence: {
        observation: 'Wrong backrest.',
        referenceObservation: 'Reference has a split backrest.',
      },
    }],
    uncertainties: [],
  }, 'task'), /regenerate/)
})

test('stops automatic verification when a frozen generation input changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verifier-tamper-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'verifier-index-'))
  const scenePath = join(root, 'scenes', '001.jpg')
  const productPath = join(root, 'products', 'black', 'front.jpg')
  const outputPath = join(root, 'outputs', 'result.png')
  try {
    await Promise.all([
      mkdir(join(root, 'scenes'), { recursive: true }),
      mkdir(join(root, 'products', 'black'), { recursive: true }),
      mkdir(join(root, 'outputs'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(scenePath, 'scene-before'),
      writeFile(productPath, 'product'),
      writeFile(outputPath, 'output'),
    ])
    const attempt = await recordGenerationAttempt({
      projectRoot: root,
      scenePath,
      productPath,
      supportingProductPaths: [],
      outputPath,
      model: 'test-model',
      resolution: '2K',
      aspectRatio: 'auto',
      version: 1,
      prompt: 'test',
      cached: false,
    }, { stateRoot })
    await writeFile(scenePath, 'scene-after')

    const result = await verifyGenerationAttempt(attempt.attemptId, runtime, undefined, {
      stateRoot,
      runCodex: async () => {
        throw new Error('Codex must not run for changed files')
      },
    })
    assert.equal(result.callsMade, 0)
    assert.equal(result.verdict.verdict, 'manual_review')
    assert.equal(result.verdict.uncertainties.length, 1)
  } finally {
    clearProjectRootsForTest()
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(stateRoot, { recursive: true, force: true }),
    ])
  }
})
