import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  assertProjectPath,
  clearProjectRootsForTest,
  isPathInside,
  outputDirFor,
  registerProjectRoot,
} from './projectAccess.js'

let root = ''
let outside = ''

beforeEach(() => {
  clearProjectRootsForTest()
  root = mkdtempSync(join(tmpdir(), 'scene-color-test-'))
  outside = join(dirname(root), `outside-${basename(root)}.png`)
  mkdirSync(join(root, 'scenes'))
  mkdirSync(join(root, 'products'))
})

afterEach(() => {
  clearProjectRootsForTest()
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { force: true })
})

test('path containment rejects sibling paths with the same prefix', () => {
  assert.equal(isPathInside(root, join(root, 'scenes', '001.png')), true)
  assert.equal(isPathInside(root, `${root}-outside/file.png`), false)
})

test('only files inside a registered project can be accessed', () => {
  const scene = join(root, 'scenes', '001.png')
  writeFileSync(scene, 'test')
  writeFileSync(outside, 'test')
  registerProjectRoot(root)

  assert.equal(assertProjectPath(scene), realpathSync(scene))
  assert.throws(() => assertProjectPath(outside), /不在已扫描的项目目录内/)
})

test('output directory is always derived from the project root', () => {
  const scene = join(root, 'scenes', '001.png')
  writeFileSync(scene, 'test')
  registerProjectRoot(root)
  assert.equal(outputDirFor(scene), join(realpathSync(root), '套版输出'))
})
