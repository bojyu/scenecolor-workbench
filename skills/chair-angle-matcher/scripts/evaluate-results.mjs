#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

function usage() {
  console.error('Usage: node evaluate-results.mjs <ground-truth.json> <predictions.json> [metrics.json]')
  process.exit(1)
}

function records(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (Array.isArray(parsed.results)) return parsed.results
  if (Array.isArray(parsed.cases)) return parsed.cases
  throw new Error('Expected an array, results array, or cases array')
}

function circularDifference(a, b) {
  const difference = Math.abs(a - b) % 360
  return Math.min(difference, 360 - difference)
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function roundedRate(value, total) {
  return total ? Math.round(value / total * 1000) / 1000 : null
}

const [truthArg, predictionArg, outputArg] = process.argv.slice(2)
if (!truthArg || !predictionArg) usage()

const truth = records(JSON.parse(await readFile(resolve(truthArg), 'utf8')))
const predictions = records(JSON.parse(await readFile(resolve(predictionArg), 'utf8')))
const predictedByPath = new Map(predictions.map(item => [item.scenePath, item]))
const paired = truth.flatMap(expected => predictedByPath.has(expected.scenePath)
  ? [{ expected, actual: predictedByPath.get(expected.scenePath) }]
  : [])
const anglePairs = paired.filter(pair => Number.isFinite(pair.expected.azimuth) && Number.isFinite(pair.actual.azimuth))
const correctDirections = paired.filter(pair => pair.expected.angle === pair.actual.angle).length
const footrestPairs = paired.filter(pair => pair.expected.footrest?.state && pair.actual.footrest?.state)
const calibratedFootrestPairs = footrestPairs.filter(pair => pair.expected.footrest.state !== 'unknown')
const correctFootrestStates = calibratedFootrestPairs.filter(pair => pair.expected.footrest.state === pair.actual.footrest.state).length
const capabilityPairs = paired.filter(pair =>
  pair.expected.footrest?.capability
  && pair.expected.footrest.capability !== 'unknown'
  && pair.actual.footrest?.capability)
const correctCapabilities = capabilityPairs.filter(pair =>
  pair.expected.footrest.capability === pair.actual.footrest.capability).length
const absentTruth = paired.filter(pair => pair.expected.footrest?.capability === 'absent')
const absentPredictions = paired.filter(pair => pair.actual.footrest?.capability === 'absent')
const absentTruePositives = absentTruth.filter(pair => pair.actual.footrest?.capability === 'absent').length
const falseAbsent = paired.filter(pair =>
  pair.expected.footrest?.capability
  && pair.expected.footrest.capability !== 'absent'
  && pair.actual.footrest?.capability === 'absent')
const nonAbsentTruth = paired.filter(pair =>
  pair.expected.footrest?.capability && pair.expected.footrest.capability !== 'absent')
const unknownFootrestTruth = paired.filter(pair =>
  pair.expected.footrest?.capability === 'unknown' || pair.expected.footrest?.state === 'unknown')
const correctUnknownFootrest = unknownFootrestTruth.filter(pair =>
  pair.actual.footrest?.capability === 'unknown' || pair.actual.footrest?.state === 'unknown').length
const extendedTruth = calibratedFootrestPairs.filter(pair => pair.expected.footrest.state === 'extended')
const extendedPredictions = calibratedFootrestPairs.filter(pair => pair.actual.footrest.state === 'extended')
const extendedTruePositives = extendedTruth.filter(pair => pair.actual.footrest.state === 'extended').length
const falseExtended = calibratedFootrestPairs.filter(pair =>
  pair.expected.footrest.state !== 'extended' && pair.actual.footrest.state === 'extended').length
const nonExtendedTruth = calibratedFootrestPairs.filter(pair => pair.expected.footrest.state !== 'extended')
const jointPairs = calibratedFootrestPairs
const correctJoint = jointPairs.filter(pair =>
  pair.expected.angle === pair.actual.angle
  && pair.expected.footrest.state === pair.actual.footrest.state).length
const multiViewTruth = paired.filter(pair => pair.expected.sceneMode === 'multi_same_model')
const multiViewSceneCorrect = multiViewTruth.filter(pair => {
  if (pair.actual.sceneMode !== 'multi_same_model') return false
  const expectedInstances = pair.expected.instances ?? []
  const actualById = new Map((pair.actual.instances ?? []).map(instance => [instance.id, instance]))
  return expectedInstances.length >= 2 && expectedInstances.every(instance => {
    const actual = actualById.get(instance.id)
    return actual?.angle === instance.angle && actual?.azimuth === instance.azimuth
  })
}).length
const multiViewInstancePairs = multiViewTruth.flatMap(pair => {
  const actualById = new Map((pair.actual.instances ?? []).map(instance => [instance.id, instance]))
  return (pair.expected.instances ?? []).map(expected => ({ expected, actual: actualById.get(expected.id) }))
})
const correctMultiViewInstances = multiViewInstancePairs.filter(pair =>
  pair.actual?.angle === pair.expected.angle && pair.actual?.azimuth === pair.expected.azimuth).length
const dangerousAutoMatchCount = paired.filter(pair =>
  pair.actual.status === 'auto'
  && (pair.expected.angle === 'multiple'
    || pair.expected.angle === 'unknown'
    || pair.expected.footrest?.capability === 'unknown'
    || pair.expected.footrest?.state === 'unknown')).length

const metrics = {
  groundTruthCount: truth.length,
  predictionCount: predictions.length,
  comparedCount: paired.length,
  coverage: truth.length ? Math.round(paired.length / truth.length * 1000) / 1000 : 0,
  directionAccuracy: paired.length ? Math.round(correctDirections / paired.length * 1000) / 1000 : null,
  medianCircularAzimuthError: median(anglePairs.map(pair => circularDifference(pair.expected.azimuth, pair.actual.azimuth))),
  meanCircularAzimuthError: anglePairs.length
    ? Math.round(anglePairs.reduce((sum, pair) => sum + circularDifference(pair.expected.azimuth, pair.actual.azimuth), 0) / anglePairs.length * 10) / 10
    : null,
  footrestCoverage: roundedRate(footrestPairs.length, truth.length),
  calibratedFootrestCount: calibratedFootrestPairs.length,
  footrestStateAccuracy: roundedRate(correctFootrestStates, calibratedFootrestPairs.length),
  footrestCapabilityAccuracy: roundedRate(correctCapabilities, capabilityPairs.length),
  absentTruthCount: absentTruth.length,
  absentPrecision: roundedRate(absentTruePositives, absentPredictions.length),
  absentRecall: roundedRate(absentTruePositives, absentTruth.length),
  falseAbsentRate: roundedRate(falseAbsent.length, nonAbsentTruth.length),
  unknownFootrestTruthCount: unknownFootrestTruth.length,
  unknownFootrestRecall: roundedRate(correctUnknownFootrest, unknownFootrestTruth.length),
  extendedPrecision: roundedRate(extendedTruePositives, extendedPredictions.length),
  extendedRecall: roundedRate(extendedTruePositives, extendedTruth.length),
  falseExtendedRate: roundedRate(falseExtended, nonExtendedTruth.length),
  jointAngleFootrestAccuracy: roundedRate(correctJoint, jointPairs.length),
  multiViewTruthCount: multiViewTruth.length,
  multiViewSceneAccuracy: roundedRate(multiViewSceneCorrect, multiViewTruth.length),
  multiViewInstanceAngleAccuracy: roundedRate(correctMultiViewInstances, multiViewInstancePairs.length),
  dangerousAutoMatchCount,
  reviewRate: predictions.length
    ? Math.round(predictions.filter(item => item.status === 'review').length / predictions.length * 1000) / 1000
    : 0,
  unmatchedRate: predictions.length
    ? Math.round(predictions.filter(item => item.status === 'unmatched').length / predictions.length * 1000) / 1000
    : 0,
  mismatches: paired
    .filter(pair => pair.expected.angle !== pair.actual.angle)
    .map(pair => ({ scenePath: pair.expected.scenePath, expected: pair.expected.angle, actual: pair.actual.angle })),
  footrestMismatches: calibratedFootrestPairs
    .filter(pair => pair.expected.footrest.state !== pair.actual.footrest.state)
    .map(pair => ({
      scenePath: pair.expected.scenePath,
      expected: pair.expected.footrest.state,
      actual: pair.actual.footrest.state,
    })),
  missingPredictions: truth.filter(item => !predictedByPath.has(item.scenePath)).map(item => item.scenePath),
}

const serialized = `${JSON.stringify(metrics, null, 2)}\n`
if (outputArg) await writeFile(resolve(outputArg), serialized, 'utf8')
else process.stdout.write(serialized)
