#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

function usage() {
  console.error('Usage: node cluster-scenes.mjs <scene-results.json> [output.json] [--tolerance=15]')
  process.exit(1)
}

function circularDifference(a, b) {
  const difference = Math.abs(a - b) % 360
  return Math.min(difference, 360 - difference)
}

function circularMean(values) {
  const radians = values.map(value => value * Math.PI / 180)
  const x = radians.reduce((sum, value) => sum + Math.cos(value), 0)
  const y = radians.reduce((sum, value) => sum + Math.sin(value), 0)
  const degrees = Math.atan2(y, x) * 180 / Math.PI
  return Math.round((((degrees % 360) + 360) % 360) * 10) / 10
}

function angleFromAzimuth(azimuth) {
  const value = ((azimuth % 360) + 360) % 360
  if (value <= 10 || value >= 350) return 'front'
  if (value < 80) return 'front_right'
  if (value <= 100) return 'right'
  if (value < 170) return 'back_right'
  if (value <= 190) return 'back'
  if (value < 260) return 'back_left'
  if (value <= 280) return 'left'
  return 'front_left'
}

const args = process.argv.slice(2)
const positional = args.filter(arg => !arg.startsWith('--'))
if (!positional[0]) usage()

const toleranceArg = args.find(arg => arg.startsWith('--tolerance='))
const tolerance = toleranceArg ? Number(toleranceArg.split('=')[1]) : 15
if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 90) usage()

const inputPath = resolve(positional[0])
const outputPath = positional[1] ? resolve(positional[1]) : null
const parsed = JSON.parse(await readFile(inputPath, 'utf8'))
const results = Array.isArray(parsed) ? parsed : parsed.results ?? parsed.cases
if (!Array.isArray(results)) throw new Error('Input must be an array or an object with a results or cases array')

const usable = results
  .filter(item => item.matchable !== false && Number.isFinite(item.azimuth) && !['multiple', 'unknown'].includes(item.angle))
  .sort((a, b) => a.azimuth - b.azimuth || b.confidence - a.confidence || a.scenePath.localeCompare(b.scenePath))

const clusters = []
for (const item of usable) {
  const candidates = clusters
    .map((cluster, index) => ({ index, difference: circularDifference(item.azimuth, cluster.centerAzimuth) }))
    .filter(candidate => candidate.difference <= tolerance)
    .sort((a, b) => a.difference - b.difference)
  if (!candidates.length) {
    clusters.push({ centerAzimuth: item.azimuth, members: [item] })
    continue
  }
  const cluster = clusters[candidates[0].index]
  cluster.members.push(item)
  cluster.centerAzimuth = circularMean(cluster.members.map(member => member.azimuth))
}

const normalizedClusters = clusters
  .map(cluster => {
    const centerAzimuth = circularMean(cluster.members.map(member => member.azimuth))
    const representative = [...cluster.members].sort((a, b) =>
      circularDifference(a.azimuth, centerAzimuth) - circularDifference(b.azimuth, centerAzimuth)
      || b.confidence - a.confidence
      || a.scenePath.localeCompare(b.scenePath))[0]
    return {
      key: `${angleFromAzimuth(centerAzimuth)}_${Math.round(centerAzimuth)}`,
      angle: angleFromAzimuth(centerAzimuth),
      centerAzimuth,
      count: cluster.members.length,
      representativeScene: representative.scenePath,
      memberScenes: cluster.members.map(member => member.scenePath).sort(),
      reviewScenes: cluster.members.filter(member => member.status === 'review').map(member => member.scenePath).sort(),
    }
  })
  .sort((a, b) => a.centerAzimuth - b.centerAzimuth)

const exceptions = results
  .filter(item => item.matchable === false || !Number.isFinite(item.azimuth) || ['multiple', 'unknown'].includes(item.angle))
  .map(item => ({ scenePath: item.scenePath, angle: item.angle, status: item.status, reason: item.reason }))

const output = {
  version: 1,
  source: inputPath,
  toleranceDegrees: tolerance,
  sceneCount: results.length,
  matchableSceneCount: usable.length,
  effectiveAngleCount: normalizedClusters.length,
  clusters: normalizedClusters,
  exceptions,
}

const serialized = `${JSON.stringify(output, null, 2)}\n`
if (outputPath) await writeFile(outputPath, serialized, 'utf8')
else process.stdout.write(serialized)
