import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { buildDraftProductTruth } from './productTruth.js'
import { scanProject } from './projectScanner.js'
import { clearProjectRootsForTest } from './projectAccess.js'

test('builds a draft truth pack from project assets and deterministic angle facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'product-truth-'))
  const scenePath = join(root, 'scenes', '001.jpg')
  const productPath = join(root, 'products', 'black', 'front.jpg')
  const trainingDir = join(root, '.scenecolor', 'skill-training')
  try {
    await Promise.all([
      mkdir(join(root, 'scenes'), { recursive: true }),
      mkdir(join(root, 'products', 'black'), { recursive: true }),
      mkdir(trainingDir, { recursive: true }),
    ])
    await Promise.all([
      writeFile(scenePath, 'scene'),
      writeFile(productPath, 'product'),
      writeFile(join(trainingDir, 'product-angle-index.json'), JSON.stringify({
        footrestCapability: 'present',
        angles: [{
          angle: 'front',
          azimuth: 0,
          footrestState: 'retracted',
          anchors: { black: 'products/black/front.jpg' },
        }],
      })),
    ])
    const result = await buildDraftProductTruth(await scanProject(root))
    assert.equal(result.packs.length, 1)
    assert.equal(result.packs[0].productId, `${basename(root)}:black`)
    assert.equal(result.packs[0].annotationStatus, 'draft')
    assert.equal(result.packs[0].assets[0].angle, 'front')
    assert.equal(result.packs[0].constraints.mirrorPolicy, 'review')
    const saved = JSON.parse(await readFile(result.path, 'utf8'))
    assert.equal(saved.packs[0].assets[0].sha256.length, 64)
  } finally {
    clearProjectRootsForTest()
    await rm(root, { recursive: true, force: true })
  }
})
