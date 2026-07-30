import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import {
  buildOutputStem,
  saveGeneratedResult,
} from './generatedResults.js'
import {
  clearProjectRootsForTest,
  registerProjectRoot,
} from './projectAccess.js'

test('output stem includes both product group and exact product filename', () => {
  assert.equal(
    buildOutputStem(join('project', 'scenes', '001.jpg'), join('project', 'black', 'front-right.jpg')),
    'black-front-right-001',
  )
  const longA = buildOutputStem(
    join('project', 'scenes', `${'scene-'.repeat(20)}a.jpg`),
    join('project', `${'group-'.repeat(12)}a`, `${'product-'.repeat(20)}a.jpg`),
  )
  const longB = buildOutputStem(
    join('project', 'scenes', `${'scene-'.repeat(20)}b.jpg`),
    join('project', `${'group-'.repeat(12)}b`, `${'product-'.repeat(20)}b.jpg`),
  )
  assert.ok(longA.length <= 124)
  assert.notEqual(longA, longB)
})

test('generated result is converted to PNG and concurrent saves never overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'generated-results-'))
  try {
    const scenePath = join(root, 'scenes', '001.jpg')
    const productPath = join(root, 'black', 'front-right.jpg')
    await Promise.all([
      mkdir(join(root, 'scenes'), { recursive: true }),
      mkdir(join(root, 'black'), { recursive: true }),
    ])
    const source = await sharp({
      create: { width: 16, height: 12, channels: 3, background: '#c33' },
    }).jpeg().toBuffer()
    await Promise.all([
      writeFile(scenePath, source),
      writeFile(productPath, source),
    ])
    clearProjectRootsForTest()
    registerProjectRoot(root)

    const [first, second] = await Promise.all([
      saveGeneratedResult({ image: source, sceneFile: scenePath, productFile: productPath, requestedVersion: 1 }),
      saveGeneratedResult({ image: source, sceneFile: scenePath, productFile: productPath, requestedVersion: 1 }),
    ])

    assert.deepEqual([first.version, second.version].sort((a, b) => a - b), [1, 2])
    assert.notEqual(first.savedPath, second.savedPath)
    for (const saved of [first, second]) {
      const stored = await readFile(saved.savedPath)
      assert.equal(stored.subarray(1, 4).toString('ascii'), 'PNG')
      assert.equal((await sharp(stored).metadata()).format, 'png')
      assert.deepEqual([saved.width, saved.height], [16, 12])
    }

    const third = await saveGeneratedResult({
      image: source,
      sceneFile: scenePath,
      productFile: productPath,
      requestedVersion: 1,
    })
    assert.equal(third.version, 3)
  } finally {
    clearProjectRootsForTest()
    await rm(root, { recursive: true, force: true })
  }
})
