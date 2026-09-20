import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { retrieveChairCases } from './chairCaseRetriever.js'

test('retrieves only adjudicated split-safe cases and deduplicates source groups', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chair-case-retrieval-'))
  const corpusPath = join(root, 'cases.jsonl')
  const base = {
    schemaVersion: 2, datasetId: 'set-a', scenePath: 'scenes/a.png',
    imageSha256: 'a'.repeat(64), sourceGroupId: 'source-a', split: 'retrieval',
    annotationStatus: 'adjudicated', retrievalEligible: true,
    labelPolicyVersion: 'chair-angle-decision-v1', angleObservability: 'coarse',
    coarseDirection: 'right', sceneMode: 'single', footrest: { capability: 'unknown', state: 'unknown' },
  }
  const cases = [
    { ...base, caseId: 'best', cropType: 'half-chair' },
    { ...base, caseId: 'duplicate', scenePath: 'scenes/a-crop.png', cropType: 'close-up' },
    { ...base, caseId: 'blind', sourceGroupId: 'source-b', split: 'blind' },
    { ...base, caseId: 'draft', sourceGroupId: 'source-c', annotationStatus: 'draft' },
    { ...base, caseId: 'unhashed', sourceGroupId: 'source-d', imageSha256: null },
    { ...base, caseId: 'left', sourceGroupId: 'source-e', coarseDirection: 'left' },
  ]
  try {
    await writeFile(corpusPath, `${cases.map(item => JSON.stringify(item)).join('\n')}\n`)
    const result = await retrieveChairCases(corpusPath, {
      angleObservability: 'coarse', coarseDirection: 'right', cropType: 'half-chair',
    }, { policyId: 'chair-angle-decision-v1', limit: 4 })
    assert.deepEqual(result.map(item => item.case.caseId), ['best', 'left'])
    assert.ok(result[0].score > result[1].score)
    assert.ok(result[0].matchedSignals.includes('cropType'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
