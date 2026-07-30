import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveCompatibleProductAngleIndex } from './productIndexResolver.js'

function indexFor(group: string, productPath: string) {
  return {
    version: 1,
    groups: [group],
    angles: [{
      key: 'front_right_20_retracted',
      angle: 'front_right',
      azimuth: 20,
      footrestState: 'retracted',
      anchors: { [group]: productPath },
    }],
  }
}

test('uses a project-local product index and rejects a foreign Skill index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'product-index-project-'))
  const productPath = join(root, 'products', '黑色', 'current.jpg')
  const trainingDir = join(root, '.scenecolor', 'skill-training')
  const projectRunDir = join(root, '.scenecolor', 'runs', 'current-project')
  const skillRoot = join(root, 'skill')
  try {
    await Promise.all([
      mkdir(join(root, 'products', '黑色'), { recursive: true }),
      mkdir(trainingDir, { recursive: true }),
      mkdir(projectRunDir, { recursive: true }),
      mkdir(join(skillRoot, 'references'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(productPath, 'current product'),
      writeFile(
        join(skillRoot, 'references', 'product-angle-index.json'),
        JSON.stringify(indexFor('black', 'products/black/foreign.jpg')),
      ),
      writeFile(
        join(projectRunDir, 'product-angle-index.json'),
        JSON.stringify(indexFor('黑色', 'products/黑色/current.jpg')),
      ),
    ])

    const resolved = await resolveCompatibleProductAngleIndex({
      root,
      scenes: [],
      products: [productPath],
      productGroups: [{ name: '黑色', images: [productPath] }],
    }, trainingDir, skillRoot)
    assert.equal(resolved.path, join(projectRunDir, 'product-angle-index.json'))
    assert.equal(resolved.anchorCount, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails closed when every index references products outside the current project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'product-index-foreign-'))
  const productPath = join(root, 'products', '黑色', 'current.jpg')
  const trainingDir = join(root, '.scenecolor', 'skill-training')
  const skillRoot = join(root, 'skill')
  try {
    await Promise.all([
      mkdir(join(root, 'products', '黑色'), { recursive: true }),
      mkdir(trainingDir, { recursive: true }),
      mkdir(join(skillRoot, 'references'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(productPath, 'current product'),
      writeFile(
        join(skillRoot, 'references', 'product-angle-index.json'),
        JSON.stringify(indexFor('black', 'products/black/foreign.jpg')),
      ),
    ])
    await assert.rejects(() => resolveCompatibleProductAngleIndex({
      root,
      scenes: [],
      products: [productPath],
      productGroups: [{ name: '黑色', images: [productPath] }],
    }, trainingDir, skillRoot), /其他产品素材/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
