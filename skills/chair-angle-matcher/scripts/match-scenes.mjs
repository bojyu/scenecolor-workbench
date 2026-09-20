#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function usage() {
  console.error('Usage: node match-scenes.mjs <scene-results.json> <product-angle-index.json> [output.json]')
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

function roundedRate(value, total) {
  return total ? Math.round(value / total * 1000) / 1000 : 0
}

const [sceneArg, indexArg, outputArg] = process.argv.slice(2)
if (!sceneArg || !indexArg) usage()

const scenePath = resolve(sceneArg)
const indexPath = resolve(indexArg)
const scenes = records(JSON.parse(await readFile(scenePath, 'utf8')))
const productIndex = JSON.parse(await readFile(indexPath, 'utf8'))
const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const decisionPolicy = JSON.parse(await readFile(resolve(scriptDirectory, '../references/decision-policy.json'), 'utf8'))

function assertProbability(value, field) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1) {
    throw new Error(`${field} must be in the range 0..1`)
  }
}

function angleFromAzimuth(value) {
  const azimuth = ((Number(value) % 360) + 360) % 360
  for (const entry of decisionPolicy.angleRanges ?? []) {
    for (const [min, max, includeMin, includeMax] of entry.ranges ?? []) {
      const aboveMin = includeMin ? azimuth >= min : azimuth > min
      const belowMax = includeMax ? azimuth <= max : azimuth < max
      if (aboveMin && belowMax) return entry.angle
    }
  }
  throw new Error(`No configured semantic angle contains azimuth ${azimuth}`)
}

function validateDecisionPolicy(policy) {
  if (!Number.isInteger(policy.version) || typeof policy.policyId !== 'string' || !policy.policyId
    || !Array.isArray(policy.angleRanges) || policy.angleRanges.length !== 8) {
    throw new Error('Decision policy must define a version, policyId, and eight angle entries')
  }
  const angles = new Set(policy.angleRanges.map(entry => entry.angle))
  if (angles.size !== 8 || policy.angleRanges.some(entry =>
    !['left', 'right', 'center'].includes(entry.direction) || !Array.isArray(entry.ranges) || !entry.ranges.length)) {
    throw new Error('Decision policy contains invalid or duplicate angle entries')
  }
  const boundaries = new Set([0, 360])
  for (const entry of policy.angleRanges) for (const range of entry.ranges) {
    if (!Array.isArray(range) || range.length !== 4
      || !Number.isFinite(range[0]) || !Number.isFinite(range[1])
      || typeof range[2] !== 'boolean' || typeof range[3] !== 'boolean'
      || range[0] < 0 || range[1] > 360 || range[0] > range[1]) {
      throw new Error(`Decision policy contains an invalid range for ${entry.angle}`)
    }
    boundaries.add(range[0])
    boundaries.add(range[1])
  }
  for (const boundary of boundaries) for (const offset of [-0.000001, 0, 0.000001]) {
    const azimuth = ((boundary + offset) % 360 + 360) % 360
    const rangeCount = policy.angleRanges.reduce((count, entry) => count + entry.ranges.filter(
      ([min, max, includeMin, includeMax]) => (includeMin ? azimuth >= min : azimuth > min)
        && (includeMax ? azimuth <= max : azimuth < max),
    ).length, 0)
    if (rangeCount !== 1) throw new Error(`Decision policy has a gap or overlap at ${azimuth}`)
  }
  for (const field of ['minAngleConfidence', 'maxOcclusion', 'minFootrestConfidence', 'minVisibleFootrest']) {
    assertProbability(policy.autoThresholds?.[field], `decisionPolicy.autoThresholds.${field}`)
  }
  assertProbability(policy.multiView?.minSameModelConfidence, 'decisionPolicy.multiView.minSameModelConfidence')
  assertProbability(policy.multiView?.minInstanceConfidence, 'decisionPolicy.multiView.minInstanceConfidence')
  if (!Number.isInteger(policy.multiView?.minInstances) || policy.multiView.minInstances < 2
    || !['auto', 'review', 'unmatched'].includes(policy.multiView?.status)
    || !Array.isArray(policy.multiView?.primaryAnglePreference)
    || !policy.multiView.primaryAnglePreference.length) {
    throw new Error('Decision policy multiView configuration is invalid')
  }
  if (typeof policy.anchorSelection?.requireDirectionMatch !== 'boolean'
    || typeof policy.anchorSelection?.allowSemanticBoundaryCrossing !== 'boolean') {
    throw new Error('Decision policy anchorSelection configuration is invalid')
  }
}

const imageFacingDirectionByAngle = Object.freeze(Object.fromEntries([
  ...(decisionPolicy.angleRanges ?? []).map(entry => [entry.angle, entry.direction]),
  ['multiple', 'multiple'],
  ['unknown', 'unknown'],
]))

function validateProductIndex(index) {
  if (!Number.isInteger(index.version) || !Array.isArray(index.angles) || !Array.isArray(index.groups)) {
    throw new Error('Product index must contain version, angles, and groups')
  }
  if (!Number.isFinite(Number(index.clusterToleranceDegrees))
    || Number(index.clusterToleranceDegrees) <= 0
    || Number(index.clusterToleranceDegrees) > 45) {
    throw new Error('Product index clusterToleranceDegrees must be in the range 0..45')
  }
  if (!index.groups.length || new Set(index.groups).size !== index.groups.length
    || index.groups.some(group => typeof group !== 'string' || !group.trim())) {
    throw new Error('Product index groups must contain unique non-empty names')
  }
  const keys = new Set()
  let retractedCount = 0
  let extendedCount = 0
  for (const anchor of index.angles) {
    if (!anchor || typeof anchor.key !== 'string' || !anchor.key || keys.has(anchor.key)) {
      throw new Error(`Product index contains a missing or duplicate anchor key: ${anchor?.key ?? 'missing'}`)
    }
    keys.add(anchor.key)
    if (!Number.isFinite(anchor.azimuth) || anchor.azimuth < 0 || anchor.azimuth >= 360) {
      throw new Error(`Product anchor ${anchor.key} has invalid azimuth`)
    }
    const derivedAngle = angleFromAzimuth(anchor.azimuth)
    if (anchor.angle !== derivedAngle) {
      throw new Error(`Product anchor ${anchor.key} angle ${anchor.angle} conflicts with azimuth ${anchor.azimuth} (${derivedAngle})`)
    }
    const expectedDirection = imageFacingDirectionByAngle[anchor.angle]
    if (anchor.imageFacingDirection !== expectedDirection) {
      throw new Error(`Product anchor ${anchor.key} requires imageFacingDirection=${expectedDirection}`)
    }
    if (!['retracted', 'partial', 'extended', 'not_applicable'].includes(anchor.footrestState)) {
      throw new Error(`Product anchor ${anchor.key} has invalid footrestState`)
    }
    if (!anchor.anchors || index.groups.some(group => typeof anchor.anchors[group] !== 'string' || !anchor.anchors[group])) {
      throw new Error(`Product anchor ${anchor.key} is missing one or more color-group paths`)
    }
    if (anchor.footrestState === 'retracted') retractedCount += index.groups.length
    if (anchor.footrestState === 'extended') extendedCount += index.groups.length
  }
  if (Number.isInteger(index.requiredAnchorCount) && index.requiredAnchorCount !== index.angles.length * index.groups.length) {
    throw new Error('Product index requiredAnchorCount does not match angles × groups')
  }
  if (Number.isInteger(index.retractedAnchorCount) && index.retractedAnchorCount !== retractedCount) {
    throw new Error('Product index retractedAnchorCount is stale')
  }
  if (Number.isInteger(index.extendedAnchorCount) && index.extendedAnchorCount !== extendedCount) {
    throw new Error('Product index extendedAnchorCount is stale')
  }
  for (const fallback of index.mirrorFallbacks ?? []) {
    if (!keys.has(fallback.sourceKey)) throw new Error(`Mirror fallback references missing anchor: ${fallback.sourceKey}`)
    if (!['auto', 'review', 'unmatched'].includes(fallback.status)) throw new Error('Mirror fallback has invalid status')
  }
  for (const [name, fallback] of Object.entries({
    absentFallback: index.absentFallback,
    invisibleFootrestFallback: index.invisibleFootrestFallback,
  })) {
    if (!fallback) continue
    if (!['auto', 'review', 'unmatched'].includes(fallback.status)) throw new Error(`${name} has invalid status`)
  }
  if (index.invisibleFootrestFallback) {
    assertProbability(index.invisibleFootrestFallback.minInvisibilityConfidence, 'minInvisibilityConfidence')
    assertProbability(index.invisibleFootrestFallback.minAngleConfidence, 'minAngleConfidence')
    assertProbability(index.invisibleFootrestFallback.maxVisibility, 'maxVisibility')
  }
}

validateDecisionPolicy(decisionPolicy)
validateProductIndex(productIndex)

function assertImageFacingDirection(record, sourceLabel) {
  const expected = imageFacingDirectionByAngle[record.angle]
  if (!expected) throw new Error(`${sourceLabel} has unsupported angle ${record.angle ?? 'missing'}`)
  if (record.imageFacingDirection !== expected) {
    throw new Error(`${sourceLabel} angle ${record.angle} requires imageFacingDirection=${expected}; received ${record.imageFacingDirection ?? 'missing'}`)
  }
  if (['multiple', 'unknown'].includes(record.angle)) {
    if (record.azimuth !== null && record.azimuth !== undefined) {
      throw new Error(`${sourceLabel} angle ${record.angle} requires azimuth=null`)
    }
    return
  }
  if (!Number.isFinite(record.azimuth)) throw new Error(`${sourceLabel} requires a numeric azimuth`)
  const derivedAngle = angleFromAzimuth(record.azimuth)
  if (record.angle !== derivedAngle) {
    throw new Error(`${sourceLabel} angle ${record.angle} conflicts with azimuth ${record.azimuth} (${derivedAngle})`)
  }
}

for (const scene of scenes) {
  if (scene.angleObservability !== 'exact') continue
  assertImageFacingDirection(scene, scene.scenePath ?? 'scene')
  for (const instance of scene.instances ?? []) {
    assertImageFacingDirection(instance, `${scene.scenePath ?? 'scene'}#${instance.id ?? 'instance'}`)
  }
}
for (const anchor of productIndex.angles) {
  assertImageFacingDirection(anchor, `product anchor ${anchor.key ?? 'unknown'}`)
}

const tolerance = Number(productIndex.clusterToleranceDegrees ?? 15)
const anchorsByKey = new Map(productIndex.angles.map(anchor => [anchor.key, anchor]))
const matches = []
const invisibleFootrestFallback = productIndex.invisibleFootrestFallback ?? null

function anchorCapability(anchor) {
  return anchor.footrestCapability ?? productIndex.footrestCapability ?? 'present'
}

function rejectScene(scene, reason) {
  for (const colorGroup of productIndex.groups) {
    matches.push({
      scenePath: scene.scenePath,
      colorGroup,
      angle: scene.angle,
      azimuth: scene.azimuth,
      imageFacingDirection: scene.imageFacingDirection,
      footrestCapability: scene.footrest?.capability ?? 'unknown',
      footrestState: scene.footrest?.state ?? 'unknown',
      observedFootrestCapability: scene.footrest?.capability ?? 'unknown',
      observedFootrestState: scene.footrest?.state ?? 'unknown',
      footrestAssumedRetracted: false,
      anchorKey: null,
      productPath: null,
      mirrored: false,
      capabilityFallback: false,
      referenceMode: 'single',
      supportingReferences: [],
      angleDifference: null,
      status: 'unmatched',
      reason,
    })
  }
}

function shouldAssumeInvisibleFootrestRetracted(scene) {
  if (!invisibleFootrestFallback) return false
  return scene.angleObservability === 'exact'
    && (scene.footrest?.capability ?? 'unknown') === 'unknown'
    && (scene.footrest?.state ?? 'unknown') === 'unknown'
    && Number(scene.footrest?.visibility) <= Number(invisibleFootrestFallback.maxVisibility ?? 0)
    && Number(scene.footrest?.confidence) >= Number(invisibleFootrestFallback.minInvisibilityConfidence ?? 0.95)
    && Number(scene.confidence) >= Number(invisibleFootrestFallback.minAngleConfidence ?? 0.7)
    && Number.isFinite(scene.azimuth)
    && !['multiple', 'unknown'].includes(scene.angle)
}

function nearestAnchor(azimuth, direction, reclineState, predicate, semanticAngle = null) {
  const candidates = productIndex.angles
    .filter(anchor => predicate(anchor)
      && Number.isFinite(anchor.azimuth)
      && (decisionPolicy.anchorSelection?.allowSemanticBoundaryCrossing || !semanticAngle || anchor.angle === semanticAngle)
      && (!decisionPolicy.anchorSelection?.requireDirectionMatch || anchor.imageFacingDirection === direction))
    .map(anchor => ({
      anchor,
      difference: circularDifference(azimuth, anchor.azimuth),
      reclinePenalty: reclineState && reclineState !== 'unknown' && anchor.reclineState !== reclineState ? 1 : 0,
    }))
    .sort((left, right) => left.difference - right.difference
      || left.reclinePenalty - right.reclinePenalty
      || left.anchor.key.localeCompare(right.anchor.key))
  return candidates[0]?.difference <= tolerance ? candidates[0] : null
}

function addMultiViewMatches(scene) {
  const footrestCapability = scene.footrest?.capability ?? 'unknown'
  const footrestState = scene.footrest?.state ?? 'unknown'
  if (footrestCapability === 'unknown' || footrestState === 'unknown') {
    rejectScene(scene, 'multi_view_footrest_unknown')
    return
  }
  if (!Number.isFinite(scene.sameModelConfidence)
    || scene.sameModelConfidence < Number(decisionPolicy.multiView.minSameModelConfidence)) {
    rejectScene(scene, 'multi_view_same_model_confidence_below_threshold')
    return
  }
  if (scene.chairCount !== scene.instances.length) {
    rejectScene(scene, 'multi_view_instance_count_conflict')
    return
  }
  if (scene.instances.some(instance => !Number.isFinite(instance.confidence)
    || instance.confidence < Number(decisionPolicy.multiView.minInstanceConfidence))) {
    rejectScene(scene, 'multi_view_instance_confidence_below_threshold')
    return
  }
  if (scene.instances.some(instance =>
    (instance.footrest?.capability ?? 'unknown') !== footrestCapability
    || (instance.footrest?.state ?? 'unknown') !== footrestState)) {
    rejectScene(scene, 'multi_view_instance_feature_conflict')
    return
  }

  const compatible = productIndex.angles.filter(anchor =>
    anchorCapability(anchor) === footrestCapability && anchor.footrestState === footrestState)
  const primary = decisionPolicy.multiView.primaryAnglePreference
    .flatMap(angle => compatible.filter(anchor => anchor.angle === angle))
    .find(anchor => scene.instances.some(instance => instance.imageFacingDirection === anchor.imageFacingDirection))
    ?? decisionPolicy.multiView.primaryAnglePreference
      .flatMap(angle => compatible.filter(anchor => anchor.angle === angle))[0]
  if (!primary) {
    rejectScene(scene, 'multi_view_primary_anchor_missing')
    return
  }

  const supportingByKey = new Map()
  for (const instance of scene.instances) {
    const selected = nearestAnchor(
      instance.azimuth,
      instance.imageFacingDirection,
      instance.reclineState ?? scene.reclineState,
      anchor => anchorCapability(anchor) === footrestCapability && anchor.footrestState === footrestState,
      instance.angle,
    )?.anchor
    if (selected && selected.key !== primary.key) supportingByKey.set(selected.key, selected)
  }
  const supporting = [...supportingByKey.values()]
  if (supporting.length < 2) {
    rejectScene(scene, 'multi_view_supporting_anchor_incomplete')
    return
  }

  for (const colorGroup of productIndex.groups) {
    const productPath = primary.anchors?.[colorGroup] ?? null
    const supportingReferences = supporting.map(anchor => ({
      anchorKey: anchor.key,
      productPath: anchor.anchors?.[colorGroup] ?? null,
      angle: anchor.angle,
      azimuth: anchor.azimuth,
    }))
    if (!productPath || supportingReferences.some(reference => !reference.productPath)) {
      matches.push({
        scenePath: scene.scenePath,
        colorGroup,
        angle: scene.angle,
        azimuth: scene.azimuth,
        imageFacingDirection: scene.imageFacingDirection,
        footrestCapability,
        footrestState,
        observedFootrestCapability: footrestCapability,
        observedFootrestState: footrestState,
        footrestAssumedRetracted: false,
        anchorKey: primary.key,
        productPath,
        mirrored: false,
        capabilityFallback: false,
        referenceMode: 'multi_view',
        supportingReferences,
        angleDifference: null,
        status: 'unmatched',
        reason: 'multi_view_anchor_missing_for_color_group',
      })
      continue
    }
    matches.push({
      scenePath: scene.scenePath,
      colorGroup,
      angle: scene.angle,
      azimuth: scene.azimuth,
      imageFacingDirection: scene.imageFacingDirection,
      footrestCapability,
      footrestState,
      observedFootrestCapability: footrestCapability,
      observedFootrestState: footrestState,
      footrestAssumedRetracted: false,
      anchorKey: primary.key,
      productPath,
      mirrored: false,
      capabilityFallback: false,
      referenceMode: 'multi_view',
      supportingReferences,
      angleDifference: null,
      status: decisionPolicy.multiView.status,
      reason: 'same_model_multi_view_reference',
    })
  }
}

for (const scene of scenes) {
  const observedFootrestCapability = scene.footrest?.capability ?? 'unknown'
  const observedFootrestState = scene.footrest?.state ?? 'unknown'

  if (!['exact', 'coarse', 'none'].includes(scene.angleObservability)) {
    rejectScene(scene, 'angle_observability_missing_or_invalid')
    continue
  }

  if (scene.sceneMode === 'multi_same_model') {
    if (['coarse', 'none'].includes(scene.angleObservability)) {
      rejectScene(scene, 'angle_observability_not_exact')
    } else if (scene.matchable === false
      || !Array.isArray(scene.instances)
      || scene.instances.length < Number(decisionPolicy.multiView.minInstances)) {
      rejectScene(scene, 'multi_view_scene_not_matchable')
    } else {
      addMultiViewMatches(scene)
    }
    continue
  }

  if (['coarse', 'none'].includes(scene.angleObservability)) {
    rejectScene(scene, 'angle_observability_not_exact')
    continue
  }
  if (scene.matchable === false || !Number.isFinite(scene.azimuth) || ['multiple', 'unknown'].includes(scene.angle)) {
    rejectScene(scene, 'scene_angle_not_matchable')
    continue
  }
  const footrestAssumedRetracted = shouldAssumeInvisibleFootrestRetracted(scene)
  const footrestCapability = footrestAssumedRetracted ? 'present' : observedFootrestCapability
  const footrestState = footrestAssumedRetracted
    ? invisibleFootrestFallback.sourceFootrestState
    : observedFootrestState
  if (footrestCapability === 'unknown' || footrestState === 'unknown') {
    rejectScene(scene, 'footrest_state_unknown')
    continue
  }

  let selectedResult = null
  let mirrored = false
  let fallbackReason = null
  let capabilityFallback = false
  let configuredStatus = footrestAssumedRetracted ? invisibleFootrestFallback.status : null

  if (footrestCapability === 'absent') {
    if (footrestState !== 'not_applicable') {
      rejectScene(scene, 'absent_capability_requires_not_applicable_state')
      continue
    }
    selectedResult = nearestAnchor(scene.azimuth, scene.imageFacingDirection, scene.reclineState, anchor =>
      anchorCapability(anchor) === 'absent' && anchor.footrestState === 'not_applicable', scene.angle)
    if (!selectedResult && productIndex.absentFallback) {
      selectedResult = nearestAnchor(scene.azimuth, scene.imageFacingDirection, scene.reclineState, anchor =>
        anchorCapability(anchor) === 'present'
        && anchor.footrestState === productIndex.absentFallback.sourceFootrestState, scene.angle)
      capabilityFallback = Boolean(selectedResult)
      fallbackReason = productIndex.absentFallback.reason
      if (capabilityFallback) configuredStatus = productIndex.absentFallback.status
    }
  } else {
    selectedResult = nearestAnchor(scene.azimuth, scene.imageFacingDirection, scene.reclineState, anchor =>
      anchorCapability(anchor) === footrestCapability && anchor.footrestState === footrestState, scene.angle)
  }

  let selected = selectedResult?.anchor ?? null
  let difference = selectedResult?.difference ?? null

  if (!selected && footrestCapability === 'present') {
    const fallback = (productIndex.mirrorFallbacks ?? []).find(rule =>
      rule.fromAngle === scene.angle
      && rule.footrestState === footrestState
      && circularDifference(scene.azimuth, rule.fromAzimuth) <= tolerance)
    if (fallback) {
      selected = anchorsByKey.get(fallback.sourceKey) ?? null
      if (!selected) throw new Error(`Mirror fallback references missing anchor: ${fallback.sourceKey}`)
      mirrored = Boolean(fallback.mirrorHorizontal)
      difference = circularDifference((360 - scene.azimuth) % 360, selected.azimuth)
      fallbackReason = fallback.reason
      configuredStatus = fallback.status
    }
  }

  if (!selected) {
    rejectScene(scene, `no_${footrestCapability}_${footrestState}_anchor_within_${tolerance}_degrees`)
    continue
  }

  for (const colorGroup of productIndex.groups) {
    const productPath = selected.anchors?.[colorGroup] ?? null
    if (!productPath) {
      matches.push({
        scenePath: scene.scenePath,
        colorGroup,
        angle: scene.angle,
        azimuth: scene.azimuth,
        imageFacingDirection: scene.imageFacingDirection,
        footrestCapability,
        footrestState,
        observedFootrestCapability,
        observedFootrestState,
        footrestAssumedRetracted,
        anchorKey: selected.key,
        productPath: null,
        mirrored,
        capabilityFallback,
        referenceMode: 'single',
        supportingReferences: [],
        angleDifference: difference,
        status: 'unmatched',
        reason: 'anchor_missing_for_color_group',
      })
      continue
    }

    const review = scene.status !== 'auto'
      || scene.confidence < Number(decisionPolicy.autoThresholds.minAngleConfidence)
      || scene.footrest?.confidence < Number(decisionPolicy.autoThresholds.minFootrestConfidence)
      || (footrestState !== 'not_applicable'
        && scene.footrest?.visibility < Number(decisionPolicy.autoThresholds.minVisibleFootrest))
    const status = configuredStatus ?? (review ? 'review' : 'auto')
    matches.push({
      scenePath: scene.scenePath,
      colorGroup,
      angle: scene.angle,
      azimuth: scene.azimuth,
      imageFacingDirection: scene.imageFacingDirection,
      footrestCapability,
      footrestState,
      observedFootrestCapability,
      observedFootrestState,
      footrestAssumedRetracted,
      anchorKey: selected.key,
      productPath,
      mirrored,
      capabilityFallback,
      referenceMode: 'single',
      supportingReferences: [],
      angleDifference: difference,
      status,
      reason: capabilityFallback
        ? fallbackReason
        : mirrored
          ? fallbackReason
          : footrestAssumedRetracted
            ? invisibleFootrestFallback.reason
            : 'same_footrest_state_and_nearest_angle',
    })
  }
}

const statusCounts = Object.fromEntries(['auto', 'review', 'unmatched'].map(status => [
  status,
  matches.filter(item => item.status === status).length,
]))
const uniqueBlockedScenes = new Set(matches.filter(item => item.status === 'unmatched').map(item => item.scenePath))
const multiViewMatches = matches.filter(item => item.referenceMode === 'multi_view' && item.status !== 'unmatched')
const output = {
  version: 7,
  decisionPolicy: decisionPolicy.policyId,
  source: scenePath,
  productIndex: indexPath,
  sceneCount: scenes.length,
  colorGroupCount: productIndex.groups.length,
  matchCount: matches.length,
  summary: {
    statusCounts,
    autoRate: roundedRate(statusCounts.auto, matches.length),
    reviewRate: roundedRate(statusCounts.review, matches.length),
    unmatchedRate: roundedRate(statusCounts.unmatched, matches.length),
    mirroredCount: matches.filter(item => item.mirrored).length,
    capabilityFallbackCount: matches.filter(item => item.capabilityFallback).length,
    assumedRetractedMatchCount: matches.filter(item => item.footrestAssumedRetracted && item.status !== 'unmatched').length,
    assumedRetractedSceneCount: new Set(matches
      .filter(item => item.footrestAssumedRetracted && item.status !== 'unmatched')
      .map(item => item.scenePath)).size,
    multiViewMatchCount: multiViewMatches.length,
    multiViewSceneCount: new Set(multiViewMatches.map(item => item.scenePath)).size,
    blockedSceneCount: uniqueBlockedScenes.size,
    externalApiCalls: 0,
  },
  matches,
}

const serialized = `${JSON.stringify(output, null, 2)}\n`
if (outputArg) await writeFile(resolve(outputArg), serialized, 'utf8')
else process.stdout.write(serialized)
