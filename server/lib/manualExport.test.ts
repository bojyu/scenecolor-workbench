import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { exportGeneratedResult } from './manualExport.js'

test('manual export writes a safe PNG name and never overwrites an existing file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scenecolor-export-'))
  const destinationDir = join(root, 'downloads')
  const sourcePath = join(root, 'source.png')
  try {
    await writeFile(sourcePath, Buffer.from('png-result'))
    const first = await exportGeneratedResult({
      sourcePath,
      preferredFileName: '../002-J97A2268-v5.png',
      destinationDir,
    })
    const second = await exportGeneratedResult({
      sourcePath,
      preferredFileName: '../002-J97A2268-v5.png',
      destinationDir,
    })

    assert.equal(basename(first), '002-J97A2268-v5.png')
    assert.equal(basename(second), '002-J97A2268-v5-2.png')
    assert.equal((await readFile(first)).toString(), 'png-result')
    assert.equal((await readFile(second)).toString(), 'png-result')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
