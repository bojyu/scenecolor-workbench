import assert from 'node:assert/strict'
import test from 'node:test'
import type { GenerationAttemptSummary } from '../types'
import { createWorkflowProgress } from './workflowProgress'
import {
  mergeDiskGenerationAttempts,
  retryableGenerationTaskKeys,
  type GenerationTaskAttemptIntegrity,
  type GenerationTaskState,
} from './generationTaskMerge'

const createdAt = '2026-07-30T03:00:00.000Z'

function summary(
  attemptId: string,
  integrity: GenerationTaskAttemptIntegrity,
  overrides: Partial<GenerationAttemptSummary> = {},
): GenerationAttemptSummary {
  return {
    attemptId,
    createdAt,
    scenePath: 'D:/project/scenes/001.png',
    productPath: 'D:/project/products/front.png',
    supportingProductPaths: [],
    outputPath: `D:/project/output/${attemptId}.png`,
    outputHash: 'hash',
    model: 'gpt-image-2',
    resolution: '2K',
    aspectRatio: 'auto',
    version: 1,
    cached: false,
    integrity,
    ...overrides,
  } as GenerationAttemptSummary
}

function task(overrides: Partial<GenerationTaskState> = {}): GenerationTaskState {
  return {
    status: 'ok',
    attempts: [],
    progress: createWorkflowProgress('generation', { createdAt }),
    ...overrides,
  }
}

test('one-click retry selects only inactive failed and cancelled tasks', () => {
  const tasks = new Map<string, GenerationTaskState>([
    ['failed', task({ status: 'error' })],
    ['stopped', task({ status: 'cancelled' })],
    ['running', task({ status: 'running' })],
    ['queued', task({ status: 'queued' })],
    ['successful', task({ status: 'ok' })],
  ])

  assert.deepEqual(
    retryableGenerationTaskKeys(tasks, new Set(['stopped'])),
    ['failed'],
  )
  assert.deepEqual(
    retryableGenerationTaskKeys(tasks),
    ['failed', 'stopped'],
  )
})

test('disk reconciliation never clears live worker compare-and-swap fields', () => {
  const progress = createWorkflowProgress('generation', {
    createdAt,
    status: 'running',
    stage: 'generating',
    stageLabel: '生成中',
    percent: 35,
  })
  const key = 'D:/project/scenes/001.png|D:/project/products/front.png'
  const current = task({
    status: 'running',
    activeRequestId: 'client-request-v2',
    pendingVersion: 2,
    progress,
    attempts: [{
      requestId: 'client-request-v2',
      batchId: 'batch-2',
      version: 2,
      status: 'running',
      createdAt,
    }],
  })

  const [mergedTask] = mergeDiskGenerationAttempts(
    new Map([[key, current]]),
    [summary('server-attempt-v1', 'valid')],
    path => `thumb:${path}`,
  ).values()

  assert.equal(mergedTask.status, 'running')
  assert.equal(mergedTask.activeRequestId, 'client-request-v2')
  assert.equal(mergedTask.pendingVersion, 2)
  assert.strictEqual(mergedTask.progress, progress)
  assert.equal(mergedTask.attempts.length, 2)
  assert.equal(mergedTask.savedPath, 'D:/project/output/server-attempt-v1.png')
})

test('disk integrity overwrites an existing local attempt and removes a stale success', () => {
  const key = 'D:/project/scenes/001.png|D:/project/products/front.png'
  const outputPath = 'D:/project/output/server-attempt-v1.png'
  const current = task({
    status: 'ok',
    savedPath: outputPath,
    image: `thumb:${outputPath}`,
    attemptId: 'server-attempt-v1',
    version: 1,
    attempts: [{
      requestId: 'client-request-v1',
      attemptId: 'server-attempt-v1',
      batchId: 'batch-1',
      version: 1,
      status: 'ok',
      createdAt,
      prompt: '沿用第一版提示词',
      savedPath: outputPath,
      image: `thumb:${outputPath}`,
    }],
  })

  const mergedTask = mergeDiskGenerationAttempts(
    new Map([[key, current]]),
    [summary('server-attempt-v1', 'mismatch')],
    path => `thumb:${path}`,
  ).get(key)!

  assert.equal(mergedTask.status, 'error')
  assert.equal(mergedTask.savedPath, undefined)
  assert.equal(mergedTask.image, undefined)
  assert.equal(mergedTask.attemptId, undefined)
  assert.equal(mergedTask.attempts.length, 1)
  assert.equal(mergedTask.attempts[0].requestId, 'client-request-v1')
  assert.equal(mergedTask.attempts[0].attemptId, 'server-attempt-v1')
  assert.equal(mergedTask.attempts[0].status, 'error')
  assert.equal(mergedTask.attempts[0].integrity, 'mismatch')
  assert.equal(mergedTask.attempts[0].prompt, '沿用第一版提示词')
})

test('unchecked metadata shows a thumbnail without downgrading audited history', () => {
  const key = 'D:/project/scenes/001.png|D:/project/products/front.png'
  const auditedPath = 'D:/project/output/server-attempt-v1.png'
  const audited = task({
    savedPath: auditedPath,
    attemptId: 'server-attempt-v1',
    version: 1,
    attempts: [{
      requestId: 'client-request-v1',
      attemptId: 'server-attempt-v1',
      batchId: 'batch-1',
      version: 1,
      status: 'ok',
      createdAt,
      savedPath: auditedPath,
      image: `thumb:${auditedPath}`,
      integrity: 'valid',
    }],
  })

  const preserved = mergeDiskGenerationAttempts(
    new Map([[key, audited]]),
    [summary('server-attempt-v1', 'unchecked')],
    path => `thumb:${path}`,
  ).get(key)!
  assert.equal(preserved.attempts[0].integrity, 'valid')
  assert.equal(preserved.attempts[0].status, 'ok')

  const newHistory = mergeDiskGenerationAttempts(
    new Map(),
    [summary('server-attempt-v2', 'unchecked', { version: 2 })],
    path => `thumb:${path}`,
  ).get(key)!
  assert.equal(newHistory.status, 'ok')
  assert.equal(newHistory.attempts[0].integrity, 'unchecked')
  assert.equal(newHistory.attempts[0].attemptId, 'server-attempt-v2')
  assert.equal(newHistory.image, 'thumb:D:/project/output/server-attempt-v2.png')
})
