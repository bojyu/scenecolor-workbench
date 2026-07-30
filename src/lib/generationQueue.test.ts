import assert from 'node:assert/strict'
import test from 'node:test'
import {
  claimNextGenerationJob,
  createGenerationAttempt,
  createGenerationJob,
  createInputFingerprint,
  enqueueGenerationJob,
  getLatestSuccessfulAttempt,
  getNextAttemptVersion,
  loadGenerationTasks,
  saveGenerationTasks,
  type GenerationAttempt,
  type GenerationJob,
  type StorageLike,
  upsertGenerationAttempt,
} from './generationQueue'

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const firstTime = '2026-07-30T02:00:00.000Z'
const secondTime = '2026-07-30T02:01:00.000Z'
const thirdTime = '2026-07-30T02:02:00.000Z'

test('input fingerprint is stable across object key order and changes with generation inputs', () => {
  const first = createInputFingerprint({
    scenePath: 'scene/001.png',
    productPath: 'product/front.png',
    options: { model: 'image-2', ratio: 'auto' },
  })
  const reordered = createInputFingerprint({
    options: { ratio: 'auto', model: 'image-2' },
    productPath: 'product/front.png',
    scenePath: 'scene/001.png',
  })
  const changed = createInputFingerprint({
    scenePath: 'scene/001.png',
    productPath: 'product/right.png',
    options: { model: 'image-2', ratio: 'auto' },
  })

  assert.equal(first, reordered)
  assert.notEqual(first, changed)
})

test('attempt upsert is immutable, monotonic, and retains the last successful disk result', () => {
  const original = createGenerationJob(
    { scenePath: 'scene.png', productPath: 'product.png' },
    { now: firstTime, jobId: 'job-1' },
  )
  const attempt1: GenerationAttempt = {
    ...createGenerationAttempt(original, { now: firstTime }),
    status: 'ok',
    savedPath: 'output/scene-product.png',
    updatedAt: secondTime,
  }
  const succeeded = upsertGenerationAttempt(original, attempt1)
  const attempt2: GenerationAttempt = {
    ...createGenerationAttempt(succeeded, { now: secondTime }),
    status: 'error',
    error: 'provider failed',
    updatedAt: thirdTime,
  }
  const failedRedo = upsertGenerationAttempt(succeeded, attempt2)

  assert.equal(original.attempts.length, 0)
  assert.equal(failedRedo.attempts.length, 2)
  assert.equal(failedRedo.status, 'error')
  assert.equal(getLatestSuccessfulAttempt(failedRedo)?.savedPath, 'output/scene-product.png')
  assert.equal(failedRedo.latestSuccessfulRequestId, attempt1.requestId)
  assert.equal(getNextAttemptVersion(failedRedo), 3)
})

test('enqueue deduplicates only active work and claim changes one queued job immutably', () => {
  const input = { scenePath: 'scene.png', productPath: 'product.png' }
  const first = enqueueGenerationJob([], input, { now: firstTime, jobId: 'job-1' })
  const duplicate = enqueueGenerationJob(first.jobs, input, { now: secondTime, jobId: 'job-2' })
  const claimed = claimNextGenerationJob(duplicate.jobs, 'worker-a', secondTime)

  assert.equal(first.added, true)
  assert.equal(duplicate.added, false)
  assert.equal(duplicate.jobs.length, 1)
  assert.equal(claimed.job?.jobId, 'job-1')
  assert.equal(claimed.job?.status, 'running')
  assert.equal(claimed.job?.claimedBy, 'worker-a')
  assert.equal(duplicate.jobs[0].status, 'queued')
})

test('storage strips data/blob URLs and restores interrupted work without losing successful history', () => {
  const storage = new MemoryStorage()
  const base = createGenerationJob(
    {
      scenePath: 'D:/project/scene.png',
      sourceImage: 'data:image/png;base64,AAAA',
      nested: { preview: 'blob:http://localhost/transient', keep: 'thumbnail/file.jpg' },
    },
    { now: firstTime, jobId: 'job-1' },
  )
  const success: GenerationAttempt = {
    requestId: 'request-1',
    attemptId: 'attempt-1',
    version: 1,
    status: 'ok',
    savedPath: 'D:/project/output/result-v1.png',
    previewPath: 'data:image/png;base64,BBBB',
    createdAt: firstTime,
    updatedAt: secondTime,
  }
  const running: GenerationAttempt = {
    requestId: 'request-2',
    version: 2,
    status: 'running',
    createdAt: secondTime,
    updatedAt: secondTime,
  }
  const interrupted: GenerationJob = {
    ...upsertGenerationAttempt(upsertGenerationAttempt(base, success), running),
    status: 'running',
    claimedBy: 'worker-a',
  }

  assert.equal(saveGenerationTasks('D:\\project', [interrupted], storage, secondTime), true)
  const serialized = [...storage.values.values()][0]
  assert.equal(serialized.includes('data:image'), false)
  assert.equal(serialized.includes('blob:'), false)

  const [restored] = loadGenerationTasks('d:/project/', storage, thirdTime)
  assert.equal(restored.status, 'cancelled')
  assert.equal(restored.claimedBy, undefined)
  assert.equal(restored.attempts[1].status, 'cancelled')
  assert.equal(restored.attempts[0].savedPath, 'D:/project/output/result-v1.png')
  assert.equal(restored.attempts[0].requestId, 'request-1')
  assert.equal(restored.attempts[0].attemptId, 'attempt-1')
  assert.equal(restored.attempts[1].requestId, 'request-2')
  assert.equal(restored.attempts[1].attemptId, undefined)
  assert.equal(getLatestSuccessfulAttempt(restored)?.version, 1)
  assert.deepEqual(restored.snapshot, {
    scenePath: 'D:/project/scene.png',
    nested: { keep: 'thumbnail/file.jpg' },
  })
})

test('legacy attemptId-only storage is migrated as an untrusted client request id', () => {
  const storage = new MemoryStorage()
  const project = 'D:/project'
  saveGenerationTasks(project, [], storage, firstTime)
  const [key] = storage.values.keys()
  storage.setItem(key, JSON.stringify({
    schemaVersion: 1,
    projectPath: project,
    savedAt: secondTime,
    jobs: [{
      jobId: 'scene|product',
      fingerprint: 'legacy:fingerprint',
      snapshot: { scene: 'scene', product: 'product' },
      status: 'ok',
      attempts: [{
        attemptId: 'client-request-previously-mislabeled',
        version: 1,
        status: 'ok',
        createdAt: firstTime,
        updatedAt: secondTime,
        savedPath: 'D:/project/output/result.png',
      }],
      createdAt: firstTime,
      updatedAt: secondTime,
    }],
  }))

  const [restored] = loadGenerationTasks(project, storage, thirdTime)
  assert.equal(restored.attempts[0].requestId, 'client-request-previously-mislabeled')
  assert.equal(restored.attempts[0].attemptId, undefined)
})

test('storage safely ignores malformed JSON, schema mismatches, and invalid jobs', () => {
  const storage = new MemoryStorage()
  const project = 'D:/project'
  saveGenerationTasks(project, [], storage, firstTime)
  const [key] = storage.values.keys()

  storage.setItem(key, '{not json')
  assert.deepEqual(loadGenerationTasks(project, storage), [])

  storage.setItem(key, JSON.stringify({ schemaVersion: 99, projectPath: project, jobs: [] }))
  assert.deepEqual(loadGenerationTasks(project, storage), [])

  storage.setItem(key, JSON.stringify({
    schemaVersion: 1,
    projectPath: project,
    jobs: [{ jobId: 7, status: 'wat', attempts: [] }],
  }))
  assert.deepEqual(loadGenerationTasks(project, storage), [])
})
