#!/usr/bin/env node

import { readFile, rename, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const inputPath = resolve(process.argv[2] ?? fileURLToPath(new URL('../references/calibration-cases.json', import.meta.url)))
const policyId = 'chair-angle-decision-v1'

function coarseDirection(angle) {
  if (['front', 'front_right', 'front_left'].includes(angle)) return 'front'
  if (['right', 'back_right'].includes(angle)) return 'right'
  if (['left', 'back_left'].includes(angle)) return 'left'
  if (angle === 'back') return 'back'
  return 'unknown'
}

function observability(item) {
  if (item.sceneMode === 'multi_same_model') return 'exact'
  if (Number(item.confidence) < 0.8 && Number(item.occlusion) >= 0.8) return 'none'
  if (Number(item.confidence) > 0.9 && Number(item.occlusion) <= 0.65) return 'exact'
  return 'coarse'
}

function caseId(scenePath) {
  return `legacy-j97a-${basename(scenePath).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-')}`
}

const unknownParts = {
  backrest: 'unknown',
  seat: 'unknown',
  leftArmrest: 'unknown',
  rightArmrest: 'unknown',
  base: 'unknown',
  footrestPad: 'unknown',
  rails: 'unknown',
}

const parsed = JSON.parse(await readFile(inputPath, 'utf8'))
const migrated = {
  ...parsed,
  version: 6,
  schemaVersion: 2,
  datasetId: 'legacy-j97a-calibration',
  labelPolicyVersion: policyId,
  cases: parsed.cases.map(item => ({
    ...item,
    schemaVersion: 2,
    caseId: caseId(item.scenePath),
    datasetId: 'legacy-j97a-calibration',
    imageSha256: null,
    perceptualGroupId: null,
    sourceGroupId: item.scenePath,
    cropParentId: null,
    split: 'regression',
    annotationStatus: 'needs_review',
    retrievalEligible: false,
    labelPolicyVersion: policyId,
    angleObservability: observability(item),
    coarseDirection: coarseDirection(item.angle),
    visibleParts: unknownParts,
    reclineState: item.reclineState ?? 'unknown',
    instances: item.instances?.map(instance => ({
      ...instance,
      reclineState: instance.reclineState ?? 'unknown',
      footrest: instance.footrest ?? item.footrest,
    })),
  })),
}

const temporaryPath = `${inputPath}.tmp`
await writeFile(temporaryPath, `${JSON.stringify(migrated, null, 2)}\n`, 'utf8')
await rename(temporaryPath, inputPath)
process.stdout.write(`Migrated ${migrated.cases.length} calibration cases to schema v2.\n`)
