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

function rate(value, total) {
  return total ? Math.round(value / total * 1000) / 1000 : null
}

function confidenceCalibration(pairs) {
  const scored = pairs.filter(pair => Number.isFinite(Number(pair.actual.confidence))).map(pair => ({
    confidence: Math.max(0, Math.min(1, Number(pair.actual.confidence))),
    correct: pair.expected.angle === pair.actual.angle ? 1 : 0,
  }))
  if (!scored.length) return { count: 0, brierScore: null, expectedCalibrationError: null }
  const brier = scored.reduce((sum, item) => sum + (item.confidence - item.correct) ** 2, 0) / scored.length
  let ece = 0
  for (let bin = 0; bin < 10; bin += 1) {
    const lower = bin / 10
    const upper = (bin + 1) / 10
    const members = scored.filter(item => item.confidence >= lower && (bin === 9 ? item.confidence <= upper : item.confidence < upper))
    if (!members.length) continue
    const averageConfidence = members.reduce((sum, item) => sum + item.confidence, 0) / members.length
    const accuracy = members.reduce((sum, item) => sum + item.correct, 0) / members.length
    ece += members.length / scored.length * Math.abs(averageConfidence - accuracy)
  }
  return {
    count: scored.length,
    brierScore: Math.round(brier * 10000) / 10000,
    expectedCalibrationError: Math.round(ece * 10000) / 10000,
  }
}

function footrestCorrect(expected, actual) {
  if (!expected.footrest?.state || expected.footrest.state === 'unknown') return true
  return expected.footrest.state === actual.footrest?.state
}

function safeAuto(pair) {
  if (pair.actual.status !== 'auto') return false
  if (pair.expected.angleObservability !== 'exact') return false
  if (pair.actual.angleObservability !== 'exact') return false
  if (['multiple', 'unknown'].includes(pair.expected.angle)) return false
  if (pair.expected.angle !== pair.actual.angle
    || pair.expected.imageFacingDirection !== pair.actual.imageFacingDirection
    || !footrestCorrect(pair.expected, pair.actual)) return false
  const expectedFootrestUnknown = pair.expected.footrest?.capability === 'unknown' || pair.expected.footrest?.state === 'unknown'
  if (!expectedFootrestUnknown) return true
  return pair.expected.footrest?.visibility === 0 && pair.actual.footrestAssumedRetracted === true
}

const [truthArg, predictionArg, outputArg] = process.argv.slice(2)
if (!truthArg || !predictionArg) usage()

const truth = records(JSON.parse(await readFile(resolve(truthArg), 'utf8')))
const predictions = records(JSON.parse(await readFile(resolve(predictionArg), 'utf8')))
const duplicatePredictionPaths = [...new Set(predictions.map(item => item.scenePath)
  .filter((path, index, all) => all.indexOf(path) !== index))]
const predictedByPath = new Map(predictions.map(item => [item.scenePath, item]))
const truthPaths = new Set(truth.map(item => item.scenePath))
const paired = truth.flatMap(expected => predictedByPath.has(expected.scenePath)
  ? [{ expected, actual: predictedByPath.get(expected.scenePath) }]
  : [])
const exactAnglePairs = paired.filter(pair =>
  pair.expected.angleObservability === 'exact' && !['multiple', 'unknown'].includes(pair.expected.angle))
const azimuthPairs = exactAnglePairs.filter(pair => Number.isFinite(pair.expected.azimuth) && Number.isFinite(pair.actual.azimuth))
const observabilityPairs = paired.filter(pair => pair.expected.angleObservability && pair.actual.angleObservability)
const coarsePairs = paired.filter(pair =>
  pair.expected.angleObservability === 'coarse' && pair.expected.coarseDirection && pair.actual.coarseDirection)
const directionPairs = exactAnglePairs.filter(pair => pair.expected.imageFacingDirection && pair.actual.imageFacingDirection)
const footrestPairs = paired.filter(pair =>
  pair.expected.footrest?.state && pair.expected.footrest.state !== 'unknown' && pair.actual.footrest?.state)
const capabilityPairs = paired.filter(pair =>
  pair.expected.footrest?.capability && pair.expected.footrest.capability !== 'unknown' && pair.actual.footrest?.capability)
const extendedTruth = footrestPairs.filter(pair => pair.expected.footrest.state === 'extended')
const extendedPredictions = footrestPairs.filter(pair => pair.actual.footrest.state === 'extended')
const extendedTruePositives = extendedTruth.filter(pair => pair.actual.footrest.state === 'extended').length
const nonExtendedTruth = footrestPairs.filter(pair => pair.expected.footrest.state !== 'extended')
const multiViewTruth = paired.filter(pair => pair.expected.sceneMode === 'multi_same_model')
const multiViewInstancePairs = multiViewTruth.flatMap(pair => {
  const actualById = new Map((pair.actual.instances ?? []).map(instance => [instance.id, instance]))
  return (pair.expected.instances ?? []).map(expected => ({ expected, actual: actualById.get(expected.id) }))
})
const correctMultiViewInstances = multiViewInstancePairs.filter(pair =>
  pair.actual?.angle === pair.expected.angle
  && Number.isFinite(pair.actual?.azimuth)
  && Number.isFinite(pair.expected.azimuth)
  && circularDifference(pair.actual.azimuth, pair.expected.azimuth) <= 15).length
const autoPairs = paired.filter(pair => pair.actual.status === 'auto')
const safeAutoPairs = autoPairs.filter(safeAuto)

const metrics = {
  groundTruthCount: truth.length,
  predictionCount: predictions.length,
  uniquePredictionCount: predictedByPath.size,
  comparedCount: paired.length,
  coverage: rate(paired.length, truth.length) ?? 0,
  exactAngleCount: exactAnglePairs.length,
  angleAccuracy: rate(exactAnglePairs.filter(pair => pair.expected.angle === pair.actual.angle).length, exactAnglePairs.length),
  directionAccuracy: rate(directionPairs.filter(pair =>
    pair.expected.imageFacingDirection === pair.actual.imageFacingDirection).length, directionPairs.length),
  observabilityAccuracy: rate(observabilityPairs.filter(pair =>
    pair.expected.angleObservability === pair.actual.angleObservability).length, observabilityPairs.length),
  coarseDirectionAccuracy: rate(coarsePairs.filter(pair =>
    pair.expected.coarseDirection === pair.actual.coarseDirection).length, coarsePairs.length),
  medianCircularAzimuthError: median(azimuthPairs.map(pair => circularDifference(pair.expected.azimuth, pair.actual.azimuth))),
  meanCircularAzimuthError: azimuthPairs.length
    ? Math.round(azimuthPairs.reduce((sum, pair) => sum + circularDifference(pair.expected.azimuth, pair.actual.azimuth), 0) / azimuthPairs.length * 10) / 10
    : null,
  footrestStateAccuracy: rate(footrestPairs.filter(pair =>
    pair.expected.footrest.state === pair.actual.footrest.state).length, footrestPairs.length),
  footrestCapabilityAccuracy: rate(capabilityPairs.filter(pair =>
    pair.expected.footrest.capability === pair.actual.footrest.capability).length, capabilityPairs.length),
  extendedPrecision: rate(extendedTruePositives, extendedPredictions.length),
  extendedRecall: rate(extendedTruePositives, extendedTruth.length),
  falseExtendedRate: rate(footrestPairs.filter(pair =>
    pair.expected.footrest.state !== 'extended' && pair.actual.footrest.state === 'extended').length, nonExtendedTruth.length),
  jointAngleFootrestAccuracy: rate(exactAnglePairs.filter(pair =>
    pair.expected.angle === pair.actual.angle && footrestCorrect(pair.expected, pair.actual)).length, exactAnglePairs.length),
  autoResultCount: autoPairs.length,
  autoJointPrecision: rate(safeAutoPairs.length, autoPairs.length),
  dangerousAutoMatchCount: autoPairs.length - safeAutoPairs.length,
  reviewRate: rate(predictions.filter(item => item.status === 'review').length, predictions.length) ?? 0,
  unmatchedRate: rate(predictions.filter(item => item.status === 'unmatched').length, predictions.length) ?? 0,
  multiViewTruthCount: multiViewTruth.length,
  multiViewInstanceAngleAccuracy: rate(correctMultiViewInstances, multiViewInstancePairs.length),
  confidenceCalibration: confidenceCalibration(exactAnglePairs),
  duplicatePredictionPaths,
  unexpectedPredictions: predictions.filter(item => !truthPaths.has(item.scenePath)).map(item => item.scenePath),
  missingPredictions: truth.filter(item => !predictedByPath.has(item.scenePath)).map(item => item.scenePath),
  angleMismatches: exactAnglePairs.filter(pair => pair.expected.angle !== pair.actual.angle).map(pair => ({
    scenePath: pair.expected.scenePath, expected: pair.expected.angle, actual: pair.actual.angle,
  })),
  footrestMismatches: footrestPairs.filter(pair =>
    pair.expected.footrest.state !== pair.actual.footrest.state).map(pair => ({
    scenePath: pair.expected.scenePath,
    expected: pair.expected.footrest.state,
    actual: pair.actual.footrest.state,
  })),
}

const serialized = `${JSON.stringify(metrics, null, 2)}\n`
if (outputArg) await writeFile(resolve(outputArg), serialized, 'utf8')
else process.stdout.write(serialized)
