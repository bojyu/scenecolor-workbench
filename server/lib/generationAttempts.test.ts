import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  listProjectGenerationAttempts,
  loadGenerationAttempt,
  recordGenerationAttempt,
} from './generationAttempts.js'

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'generation-attempt-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'generation-attempt-index-'))
  const scenePath = join(root, 'scenes', '001.jpg')
  const productPath = join(root, 'products', 'black', 'front.jpg')
  const supportPath = join(root, 'products', 'black', 'side.jpg')
  const outputPath = join(root, 'outputs', 'result.png')
  await Promise.all([
    mkdir(join(root, 'scenes'), { recursive: true }),
    mkdir(join(root, 'products', 'black'), { recursive: true }),
    mkdir(join(root, 'outputs'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(scenePath, 'scene'),
    writeFile(productPath, 'product'),
    writeFile(supportPath, 'support'),
    writeFile(outputPath, 'output'),
  ])
  return { root, stateRoot, scenePath, productPath, supportPath, outputPath }
}

function attemptInput(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return {
    projectRoot: fixture.root,
    scenePath: fixture.scenePath,
    productPath: fixture.productPath,
    supportingProductPaths: [fixture.supportPath],
    outputPath: fixture.outputPath,
    model: 'test-model',
    resolution: '2K',
    aspectRatio: 'auto',
    version: 2,
    prompt: 'replace chair safely',
    cached: false,
  }
}

async function removeFixture(fixture: Awaited<ReturnType<typeof createFixture>>) {
  await Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(fixture.stateRoot, { recursive: true, force: true }),
  ])
}

test('records an immutable generation attempt without persisting credentials', async () => {
  const fixture = await createFixture()
  try {
    const attempt = await recordGenerationAttempt(attemptInput(fixture), { stateRoot: fixture.stateRoot })

    const loaded = await loadGenerationAttempt(attempt.attemptId, { stateRoot: fixture.stateRoot })
    assert.deepEqual(loaded, attempt)

    const metadata = await listProjectGenerationAttempts(fixture.root, {
      stateRoot: fixture.stateRoot,
    })
    assert.equal(metadata.length, 1)
    assert.equal(metadata[0].attemptId, attempt.attemptId)
    assert.equal(metadata[0].outputPath, fixture.outputPath)
    assert.equal(metadata[0].integrity, 'unchecked')
    assert.equal('prompt' in metadata[0], false)
    assert.equal(loaded.inputHashes.supporting.length, 1)
    assert.equal(loaded.promptHash.length, 64)

    const serialized = await readFile(
      join(fixture.root, '.scenecolor', 'generation-attempts', `${attempt.attemptId}.json`),
      'utf8',
    )
    assert.doesNotMatch(serialized, /apiKey|Bearer/i)

    assert.equal((await listProjectGenerationAttempts(fixture.root, {
      stateRoot: fixture.stateRoot,
      mode: 'audit',
    }))[0].integrity, 'valid')
    await writeFile(fixture.outputPath, 'overwritten')
    assert.equal((await listProjectGenerationAttempts(fixture.root, {
      stateRoot: fixture.stateRoot,
      mode: 'audit',
    }))[0].integrity, 'mismatch')
    await rm(fixture.outputPath)
    assert.equal((await listProjectGenerationAttempts(fixture.root, {
      stateRoot: fixture.stateRoot,
      mode: 'audit',
    }))[0].integrity, 'missing')
    assert.equal((await listProjectGenerationAttempts(fixture.root, {
      stateRoot: fixture.stateRoot,
    }))[0].integrity, 'unchecked')
  } finally {
    await removeFixture(fixture)
  }
})

test('uses generation-start buffers when input files are replaced before attempt recording', async () => {
  const fixture = await createFixture()
  try {
    const originalBuffers = {
      scene: Buffer.from('scene-at-generation-start'),
      product: Buffer.from('product-at-generation-start'),
      supporting: [Buffer.from('support-at-generation-start')],
    }
    await Promise.all([
      writeFile(fixture.scenePath, originalBuffers.scene),
      writeFile(fixture.productPath, originalBuffers.product),
      writeFile(fixture.supportPath, originalBuffers.supporting[0]),
    ])

    // Simulate another workflow replacing source files while generation is in
    // flight. Attempt recording must use the already captured source buffers.
    await Promise.all([
      writeFile(fixture.scenePath, 'scene-replaced-during-generation'),
      writeFile(fixture.productPath, 'product-replaced-during-generation'),
      writeFile(fixture.supportPath, 'support-replaced-during-generation'),
    ])

    const attempt = await recordGenerationAttempt({
      ...attemptInput(fixture),
      inputBuffers: originalBuffers,
    }, { stateRoot: fixture.stateRoot })

    assert.deepEqual(attempt.inputHashes, {
      scene: sha256(originalBuffers.scene),
      product: sha256(originalBuffers.product),
      supporting: originalBuffers.supporting.map(sha256),
    })
    assert.notEqual(attempt.inputHashes.scene, sha256('scene-replaced-during-generation'))
    assert.notEqual(attempt.inputHashes.product, sha256('product-replaced-during-generation'))
  } finally {
    await removeFixture(fixture)
  }
})

test('accepts precomputed input hashes and validates their shape', async () => {
  const fixture = await createFixture()
  try {
    const inputHashes = {
      scene: sha256('scene-snapshot'),
      product: sha256('product-snapshot'),
      supporting: [sha256('support-snapshot')],
    }
    const attempt = await recordGenerationAttempt({
      ...attemptInput(fixture),
      inputHashes,
    }, { stateRoot: fixture.stateRoot })
    assert.deepEqual(attempt.inputHashes, inputHashes)

    await assert.rejects(
      recordGenerationAttempt({
        ...attemptInput(fixture),
        inputHashes: { ...inputHashes, supporting: [] },
      }, { stateRoot: fixture.stateRoot }),
      /输入哈希快照无效/,
    )
  } finally {
    await removeFixture(fixture)
  }
})

test('project-local record recovers a missing or corrupt global index and remains scoped to its project', async () => {
  const fixture = await createFixture()
  const otherRoot = await mkdtemp(join(tmpdir(), 'generation-attempt-other-project-'))
  try {
    const attempt = await recordGenerationAttempt(attemptInput(fixture), { stateRoot: fixture.stateRoot })
    const indexPath = join(fixture.stateRoot, '.scenecolor', 'generation-attempt-index.json')

    await writeFile(indexPath, '{broken json', 'utf8')
    const recovered = await loadGenerationAttempt(attempt.attemptId, {
      stateRoot: fixture.stateRoot,
      projectRoot: fixture.root,
    })
    assert.deepEqual(recovered, attempt)

    const repairedIndex = JSON.parse(await readFile(indexPath, 'utf8'))
    assert.equal(repairedIndex.attempts[attempt.attemptId].projectRoot, fixture.root)
    assert.equal(
      repairedIndex.attempts[attempt.attemptId].attemptPath,
      join(fixture.root, '.scenecolor', 'generation-attempts', `${attempt.attemptId}.json`),
    )

    await assert.rejects(
      loadGenerationAttempt(attempt.attemptId, {
        stateRoot: fixture.stateRoot,
        projectRoot: otherRoot,
      }),
      /ENOENT|不存在/,
    )
    await assert.rejects(
      loadGenerationAttempt('../outside', {
        stateRoot: fixture.stateRoot,
        projectRoot: fixture.root,
      }),
      /ID 无效/,
    )
  } finally {
    await Promise.all([
      removeFixture(fixture),
      rm(otherRoot, { recursive: true, force: true }),
    ])
  }
})

test('listing rebuilds the global index once from validated project-local records', async () => {
  const fixture = await createFixture()
  try {
    const first = await recordGenerationAttempt(attemptInput(fixture), { stateRoot: fixture.stateRoot })
    await writeFile(fixture.outputPath, 'second output')
    const second = await recordGenerationAttempt({
      ...attemptInput(fixture),
      version: 3,
    }, { stateRoot: fixture.stateRoot })
    const indexPath = join(fixture.stateRoot, '.scenecolor', 'generation-attempt-index.json')
    await rm(indexPath)

    const listed = await listProjectGenerationAttempts(fixture.root, {
      stateRoot: fixture.stateRoot,
      mode: 'metadata',
    })
    assert.equal(listed.length, 2)
    assert.ok(listed.every(item => item.integrity === 'unchecked'))

    const rebuiltIndex = JSON.parse(await readFile(indexPath, 'utf8'))
    assert.deepEqual(
      Object.keys(rebuiltIndex.attempts).sort(),
      [first.attemptId, second.attemptId].sort(),
    )
    assert.deepEqual(
      await loadGenerationAttempt(first.attemptId, { stateRoot: fixture.stateRoot }),
      first,
    )
    assert.deepEqual(
      await loadGenerationAttempt(second.attemptId, { stateRoot: fixture.stateRoot }),
      second,
    )
  } finally {
    await removeFixture(fixture)
  }
})

test('global index cache failures do not hide a committed project-local attempt', async () => {
  const fixture = await createFixture()
  try {
    const blockedStateRoot = join(fixture.root, 'state-root-is-a-file')
    await writeFile(blockedStateRoot, 'not a directory')

    const attempt = await recordGenerationAttempt(attemptInput(fixture), {
      stateRoot: blockedStateRoot,
    })
    const localPath = join(
      fixture.root,
      '.scenecolor',
      'generation-attempts',
      `${attempt.attemptId}.json`,
    )
    assert.equal(JSON.parse(await readFile(localPath, 'utf8')).attemptId, attempt.attemptId)

    assert.deepEqual(
      await loadGenerationAttempt(attempt.attemptId, {
        stateRoot: blockedStateRoot,
        projectRoot: fixture.root,
      }),
      attempt,
    )
    const listed = await listProjectGenerationAttempts(fixture.root, {
      stateRoot: blockedStateRoot,
      mode: 'metadata',
    })
    assert.equal(listed.length, 1)
    assert.equal(listed[0].attemptId, attempt.attemptId)
  } finally {
    await removeFixture(fixture)
  }
})
