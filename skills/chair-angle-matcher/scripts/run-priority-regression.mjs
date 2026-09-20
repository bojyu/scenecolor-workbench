#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const skillRoot = resolve(scriptDir, '..')
const repositoryRoot = resolve(skillRoot, '..', '..')
const manifestPath = resolve(skillRoot, 'references', 'priority-one-training-cases.json')
const fixtureRoot = resolve(skillRoot, 'references', 'priority-regression')
const matcherPath = resolve(scriptDir, 'match-scenes.mjs')

function records(artifact) {
  if (Array.isArray(artifact)) return artifact
  if (Array.isArray(artifact.results)) return artifact.results
  if (Array.isArray(artifact.cases)) return artifact.cases
  throw new Error('Regression source must contain results or cases')
}

function assertEqual(actual, expected, label, failures) {
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function validateGate(matches, expectedGate, label, failures) {
  const statuses = new Set(matches.map(item => item.status))
  if (expectedGate === 'unmatched') {
    if (statuses.size !== 1 || !statuses.has('unmatched')) failures.push(`${label}: expected every group to be unmatched`)
    return
  }
  if (expectedGate === 'review') {
    if (statuses.size !== 1 || !statuses.has('review')) failures.push(`${label}: expected every group to require review`)
    return
  }
  if (statuses.size !== 1 || !statuses.has('auto')) {
    failures.push(`${label}: expected every group to be auto`)
    return
  }
  if (expectedGate === 'auto_assumed_retracted'
    && matches.some(item => item.footrestAssumedRetracted !== true)) {
    failures.push(`${label}: expected every group to use the retracted-footrest assumption`)
  }
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const temporaryRoot = await mkdtemp(join(tmpdir(), 'scenecolor-priority-regression-'))
const failures = []
const datasets = []

try {
  for (const dataset of manifest.datasets ?? []) {
    const datasetFixtureRoot = resolve(fixtureRoot, dataset.name)
    const sceneResultsPath = join(datasetFixtureRoot, 'scene-angle-results.json')
    const productIndexPath = join(datasetFixtureRoot, 'product-angle-index.json')
    const outputPath = join(temporaryRoot, `${dataset.name}.json`)
    await execFileAsync(process.execPath, [matcherPath, sceneResultsPath, productIndexPath, outputPath], {
      cwd: repositoryRoot,
      windowsHide: true,
    })

    const sceneArtifact = JSON.parse(await readFile(sceneResultsPath, 'utf8'))
    const observations = new Map(records(sceneArtifact).map(item => [item.scenePath, item]))
    const output = JSON.parse(await readFile(outputPath, 'utf8'))
    const expected = dataset.expectedMatchSummary ?? {}
    assertEqual(output.matchCount, expected.matchCount, `${dataset.name}.matchCount`, failures)
    assertEqual(output.summary?.statusCounts?.auto, expected.auto, `${dataset.name}.auto`, failures)
    assertEqual(output.summary?.statusCounts?.review, expected.review, `${dataset.name}.review`, failures)
    assertEqual(output.summary?.statusCounts?.unmatched, expected.unmatched, `${dataset.name}.unmatched`, failures)
    assertEqual(output.summary?.blockedSceneCount, expected.blockedSceneCount, `${dataset.name}.blockedSceneCount`, failures)
    if ('assumedRetractedSceneCount' in expected) {
      assertEqual(
        output.summary?.assumedRetractedSceneCount,
        expected.assumedRetractedSceneCount,
        `${dataset.name}.assumedRetractedSceneCount`,
        failures,
      )
    }
    if ('multiViewSceneCount' in expected) {
      assertEqual(output.summary?.multiViewSceneCount, expected.multiViewSceneCount, `${dataset.name}.multiViewSceneCount`, failures)
    }

    for (const item of dataset.cases ?? []) {
      const relativeScene = `scenes/${item.scene}`
      const observation = observations.get(relativeScene)
      const label = `${dataset.name}/${item.scene}`
      if (!observation) {
        failures.push(`${label}: source observation is missing`)
        continue
      }
      assertEqual(observation.angleObservability, item.angleObservability, `${label}.angleObservability`, failures)
      assertEqual(observation.angle, item.angle, `${label}.angle`, failures)
      assertEqual(observation.footrest?.state, item.footrestState, `${label}.footrestState`, failures)
      const sceneMatches = (output.matches ?? []).filter(match => match.scenePath === relativeScene)
      assertEqual(sceneMatches.length, dataset.colorGroups, `${label}.colorGroupCount`, failures)
      validateGate(sceneMatches, item.expectedGate, label, failures)
    }
    datasets.push({
      name: dataset.name,
      sceneCount: dataset.sceneCount,
      matchCount: output.matchCount,
      statusCounts: output.summary?.statusCounts,
    })
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

const report = {
  version: 1,
  evaluationRole: 'known-case-regression',
  generalizationClaim: false,
  caseCount: datasets.reduce((total, dataset) => total + dataset.sceneCount, 0),
  datasets,
  passed: failures.length === 0,
  failures,
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (failures.length) process.exitCode = 1
