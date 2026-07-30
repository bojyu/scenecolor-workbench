import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearProjectRootsForTest } from './projectAccess.js'
import { scanProject } from './projectScanner.js'
import { retrieveChairCases } from './chairCaseRetriever.js'
import { loadChairSkillResults } from './skillResults.js'
import {
  publishSkillTrainingReview,
  recalculateSkillTrainingReview,
  saveInlineSkillTrainingReview,
} from './skillTrainingWorkflow.js'

test('requires full human review, recalculates corrected labels, and publishes adjudicated cases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-training-workflow-'))
  const scenePath = join(root, 'scenes', '001.jpg')
  const productPath = join(root, 'products', 'white', 'reference.jpg')
  const trainingDir = join(root, '.scenecolor', 'skill-training')
  const runDir = join(trainingDir, 'runs', 'codex-source')
  try {
    await mkdir(join(root, 'scenes'), { recursive: true })
    await mkdir(join(root, 'products', 'white'), { recursive: true })
    await mkdir(runDir, { recursive: true })
    await writeFile(scenePath, 'scene-image')
    await writeFile(productPath, 'product-image')
    await writeFile(join(trainingDir, 'product-angle-index.json'), JSON.stringify({
      version: 1,
      clusterToleranceDegrees: 15,
      footrestCapability: 'present',
      groups: ['white'],
      angles: [{
        key: 'front_right_20_retracted', angle: 'front_right', azimuth: 20,
        imageFacingDirection: 'right', footrestState: 'retracted',
        anchors: { white: 'products/white/reference.jpg' },
      }],
    }))
    await writeFile(join(runDir, 'scene-angle-results.json'), JSON.stringify({ results: [{
      scenePath: 'scenes/001.jpg', angle: 'front_right', azimuth: 20,
      imageFacingDirection: 'right', angleObservability: 'exact', coarseDirection: 'front',
      confidence: 0.94, occlusion: 0.1, chairCount: 1, matchable: true, status: 'auto',
      decisiveCue: 'original', sceneMode: 'single', sameModelConfidence: null,
      reclineState: 'unknown', visibleParts: {}, instances: [],
      footrest: { capability: 'present', state: 'retracted', visibility: 1, confidence: 0.98, decisiveCue: 'visible' },
    }] }))
    await writeFile(join(trainingDir, 'current-run.json'), JSON.stringify({
      version: 1,
      sceneResultsPath: 'runs/codex-source/scene-angle-results.json',
      matchResultsPath: 'runs/codex-source/footrest-matching-results.json',
    }))
    const project = await scanProject(root)
    await assert.rejects(() => recalculateSkillTrainingReview(project, []), /逐图核对全部场景/)
    const review = await recalculateSkillTrainingReview(project, [{
      scenePath,
      reviewState: 'corrected',
      angleObservability: 'exact',
      azimuth: 330,
      coarseDirection: 'front',
      sceneMode: 'single',
      footrest: { capability: 'present', state: 'retracted', visibility: 1, confidence: 1 },
      reviewerNote: '人工确认应为左前斜。',
    }])
    assert.equal(review.correctedCount, 1)
    const current = JSON.parse(await readFile(join(trainingDir, 'current-run.json'), 'utf8'))
    const adjusted = JSON.parse(await readFile(join(trainingDir, current.sceneResultsPath), 'utf8'))
    assert.equal(adjusted.results[0].angle, 'front_left')
    assert.equal(adjusted.results[0].imageFacingDirection, 'left')
    assert.equal(adjusted.results[0].confidence, 1)

    const publication = await publishSkillTrainingReview(project, review.reviewId, 'database')
    assert.equal(publication.writtenCount, 1)
    const cases = (await readFile(publication.corpusPath, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line))
    assert.equal(cases[0].annotationStatus, 'adjudicated')
    assert.equal(cases[0].retrievalEligible, true)
    assert.equal(cases[0].angle, 'front_left')
    assert.equal(cases[0].previousObservation.angle, 'front_right')
    const repeated = await publishSkillTrainingReview(project, review.reviewId, 'database')
    assert.equal(repeated.totalCount, 1)
    const retrieved = await retrieveChairCases(publication.corpusPath, {
      angleObservability: 'exact', coarseDirection: 'front',
      footrest: { capability: 'present', state: 'retracted' },
    }, { policyId: 'chair-angle-decision-v1' })
    assert.equal(retrieved[0].case.caseId, cases[0].caseId)
  } finally {
    clearProjectRootsForTest()
    await rm(root, { recursive: true, force: true })
  }
})

test('inline correction reruns deterministic matching and advances the current run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inline-skill-rematch-'))
  const scenePath = join(root, 'scenes', '001.jpg')
  const productPath = join(root, 'products', 'white', 'right.jpg')
  const trainingDir = join(root, '.scenecolor', 'skill-training')
  try {
    await mkdir(join(root, 'scenes'), { recursive: true })
    await mkdir(join(root, 'products', 'white'), { recursive: true })
    await mkdir(trainingDir, { recursive: true })
    await writeFile(scenePath, 'inline-scene-image')
    await writeFile(productPath, 'inline-product-image')
    await writeFile(join(trainingDir, 'scene-angle-results.json'), JSON.stringify({
      version: 1,
      results: [{
        scenePath: 'scenes/001.jpg',
        angle: 'front',
        azimuth: 0,
        imageFacingDirection: 'center',
        angleObservability: 'exact',
        coarseDirection: 'front',
        confidence: 0.8,
        occlusion: 0,
        chairCount: 1,
        matchable: true,
        status: 'auto',
        decisiveCue: 'original front',
        sceneMode: 'single',
        footrest: {
          capability: 'present',
          state: 'retracted',
          visibility: 1,
          confidence: 1,
          decisiveCue: 'visible',
        },
      }],
    }))
    await writeFile(join(trainingDir, 'footrest-matching-results.json'), JSON.stringify({ matches: [] }))
    await writeFile(join(trainingDir, 'product-angle-index.json'), JSON.stringify({
      version: 1,
      clusterToleranceDegrees: 15,
      footrestCapability: 'present',
      groups: ['white'],
      angles: [{
        key: 'right_90_retracted',
        angle: 'right',
        azimuth: 90,
        imageFacingDirection: 'right',
        footrestState: 'retracted',
        anchors: { white: 'products/white/right.jpg' },
      }],
    }))
    const project = await scanProject(root)
    const saved = await saveInlineSkillTrainingReview(project, {
      scenePath,
      reviewState: 'corrected',
      angleObservability: 'exact',
      azimuth: 90,
      coarseDirection: 'right',
      sceneMode: 'single',
      footrest: { capability: 'present', state: 'retracted', visibility: 1, confidence: 1 },
      reviewerNote: 'corrected to right profile',
    }, 'chair-angle-matcher', {
      skillCorpusPath: join(root, '.scenecolor', 'test-skill-corpus', 'training-cases.jsonl'),
    })

    assert.equal(saved.rematch.matchCount, 1)
    const current = JSON.parse(await readFile(join(trainingDir, 'current-run.json'), 'utf8'))
    assert.match(current.runId, /^inline-/)
    const results = await loadChairSkillResults(project)
    assert.equal(results.sceneResults[0].angle, 'right')
    assert.equal(results.matches[0].status, 'auto')
    assert.equal(results.matches[0].productPath, productPath)
  } finally {
    clearProjectRootsForTest()
    await rm(root, { recursive: true, force: true })
  }
})
