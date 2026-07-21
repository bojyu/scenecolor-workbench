import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearProjectRootsForTest } from './projectAccess.js'
import { scanProject } from './projectScanner.js'
import { loadChairSkillResults } from './skillResults.js'

const completeCase = {
  scenePath: 'scenes/001.jpg',
  angle: 'front',
  azimuth: 0,
  confidence: 0.96,
  occlusion: 0,
  chairCount: 1,
  matchable: true,
  status: 'auto',
  decisiveCue: '椅子结构近似对称。',
  footrest: {
    capability: 'present',
    state: 'retracted',
    visibility: 1,
    confidence: 0.98,
    decisiveCue: '脚垫收纳于座面下方。',
  },
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
}

function createProject(localCalibration: unknown, fallbackCalibration?: unknown) {
  const container = mkdtempSync(join(tmpdir(), 'skill-results-'))
  const projectRoot = join(container, 'project')
  const trainingDir = join(projectRoot, '.scenecolor', 'skill-training')
  mkdirSync(join(projectRoot, 'scenes'), { recursive: true })
  mkdirSync(join(projectRoot, 'products', 'white'), { recursive: true })
  mkdirSync(trainingDir, { recursive: true })
  writeFileSync(join(projectRoot, 'scenes', '001.jpg'), '')
  writeFileSync(join(projectRoot, 'products', 'white', 'reference.jpg'), '')
  writeJson(join(trainingDir, 'scene-angle-results.json'), localCalibration)
  writeJson(join(trainingDir, 'footrest-matching-results.json'), {
    matches: [{
      scenePath: 'scenes/001.jpg',
      colorGroup: 'white',
      productPath: 'products/white/reference.jpg',
      angle: 'front',
      azimuth: 0,
      footrestCapability: 'present',
      footrestState: 'retracted',
      observedFootrestCapability: 'present',
      observedFootrestState: 'retracted',
      footrestAssumedRetracted: false,
      anchorKey: 'front_0_retracted',
      mirrored: false,
      capabilityFallback: false,
      referenceMode: 'single',
      supportingReferences: [],
      angleDifference: 0,
      status: 'auto',
      reason: 'direct match',
    }],
    summary: { externalApiCalls: 0 },
  })
  if (fallbackCalibration) {
    const referencesDir = join(container, 'skills', 'chair-angle-matcher', 'references')
    mkdirSync(referencesDir, { recursive: true })
    writeJson(join(referencesDir, 'calibration-cases.json'), fallbackCalibration)
  }
  return { container, projectRoot }
}

test('falls back to complete cases when a local legacy results file has no footrest labels', async () => {
  const { container, projectRoot } = createProject({
    results: [{
      scenePath: 'scenes/001.jpg', angle: 'front', azimuth: 0, confidence: 0.96,
      occlusion: 0, chairCount: 1, matchable: true, status: 'auto', reason: 'legacy angle only',
    }],
  }, { cases: [completeCase] })
  clearProjectRootsForTest()
  try {
    const result = await loadChairSkillResults(await scanProject(projectRoot))
    assert.equal(result.summary.sceneCount, 1)
    assert.equal(result.sceneResults[0].footrest.state, 'retracted')
    assert.equal(result.summary.matchCount, 1)
  } finally {
    clearProjectRootsForTest()
    rmSync(container, { recursive: true, force: true })
  }
})

test('accepts complete scene records stored under the legacy results key', async () => {
  const { container, projectRoot } = createProject({ results: [completeCase] })
  clearProjectRootsForTest()
  try {
    const result = await loadChairSkillResults(await scanProject(projectRoot))
    assert.equal(result.summary.sceneCount, 1)
    assert.equal(result.sceneResults[0].decisiveCue, completeCase.decisiveCue)
  } finally {
    clearProjectRootsForTest()
    rmSync(container, { recursive: true, force: true })
  }
})
