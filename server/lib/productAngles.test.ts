import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearProjectRootsForTest, registerProjectRoot } from './projectAccess.js'
import { getProductAngleAnalysis, saveProductAngleAnalysis } from './productAngles.js'

let root = ''
let product = ''

beforeEach(() => {
  clearProjectRootsForTest()
  root = mkdtempSync(join(tmpdir(), 'product-angle-store-'))
  mkdirSync(join(root, 'scenes'))
  mkdirSync(join(root, 'products', '米白色'), { recursive: true })
  product = join(root, 'products', '米白色', '右前.jpg')
  writeFileSync(product, 'fake-product-image')
  registerProjectRoot(root)
})

afterEach(() => {
  clearProjectRootsForTest()
  rmSync(root, { recursive: true, force: true })
})

test('persists one idempotent angle record per product reference', async () => {
  await saveProductAngleAnalysis(product, {
    angle: 'front_right', azimuth: 45, confidence: 0.92, reason: 'Visible right armrest',
  }, { source: 'agent' })
  await saveProductAngleAnalysis(product, {
    angle: 'right', azimuth: 88, confidence: 0.96, reason: 'Reviewed side view',
  }, { source: 'agent' })
  const saved = await getProductAngleAnalysis(product)
  assert.equal(saved?.productPath, realpathSync(product))
  assert.equal(saved?.angle, 'right')
  assert.equal(saved?.reason, 'Reviewed side view')
})
