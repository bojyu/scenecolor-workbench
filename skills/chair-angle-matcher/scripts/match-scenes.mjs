#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

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
if (!Array.isArray(productIndex.angles) || !Array.isArray(productIndex.groups)) {
  throw new Error('Product index must contain angles and groups arrays')
}

const imageFacingDirectionByAngle = Object.freeze({
  front: 'center',
  front_right: 'right',
  right: 'right',
  left: 'left',
  front_left: 'left',
  multiple: 'multiple',
})

function assertImageFacingDirection(record, sourceLabel) {
  const expected = imageFacingDirectionByAngle[record.angle]
  if (!expected) return
  if (record.imageFacingDirection !== expected) {
    throw new Error(`${sourceLabel} angle ${record.angle} requires imageFacingDirection=${expected}; received ${record.imageFacingDirection ?? 'missing'}`)
  }
}

for (const scene of scenes) {
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
  return (scene.angleObservability === undefined || scene.angleObservability === 'exact')
    && (scene.footrest?.capability ?? 'unknown') === 'unknown'
    && (scene.footrest?.state ?? 'unknown') === 'unknown'
    && Number(scene.footrest?.visibility) <= Number(invisibleFootrestFallback.maxVisibility ?? 0)
    && Number(scene.footrest?.confidence) >= Number(invisibleFootrestFallback.minInvisibilityConfidence ?? 0.95)
    && Number(scene.confidence) >= Number(invisibleFootrestFallback.minAngleConfidence ?? 0.7)
    && Number.isFinite(scene.azimuth)
    && !['multiple', 'unknown'].includes(scene.angle)
}

function nearestAnchor(azimuth, predicate) {
  const candidates = productIndex.angles
    .filter(anchor => predicate(anchor) && Number.isFinite(anchor.azimuth))
    .map(anchor => ({ anchor, difference: circularDifference(azimuth, anchor.azimuth) }))
    .sort((left, right) => left.difference - right.difference || left.anchor.key.localeCompare(right.anchor.key))
  return candidates[0]?.difference <= tolerance ? candidates[0] : null
}

function addMultiViewMatches(scene) {
  const primary = anchorsByKey.get(scene.multiView?.primaryAnchorKey)
  const supporting = (scene.multiView?.supportingAnchorKeys ?? []).map(key => anchorsByKey.get(key))
  if (!primary || supporting.length < 2 || supporting.some(anchor => !anchor)) {
    rejectScene(scene, 'multi_view_anchor_missing')
    return
  }

  const footrestCapability = scene.footrest?.capability ?? 'unknown'
  const footrestState = scene.footrest?.state ?? 'unknown'
  const anchors = [primary, ...supporting]
  if (footrestCapability === 'unknown' || footrestState === 'unknown') {
    rejectScene(scene, 'multi_view_footrest_unknown')
    return
  }
  if (anchors.some(anchor => anchorCapability(anchor) !== footrestCapability || anchor.footrestState !== footrestState)) {
    rejectScene(scene, 'multi_view_feature_conflict')
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
      status: 'review',
      reason: 'same_model_multi_view_reference',
    })
  }
}

for (const scene of scenes) {
  const observedFootrestCapability = scene.footrest?.capability ?? 'unknown'
  const observedFootrestState = scene.footrest?.state ?? 'unknown'

  if (scene.sceneMode === 'multi_same_model') {
    if (['coarse', 'none'].includes(scene.angleObservability)) {
      rejectScene(scene, 'angle_observability_not_exact')
    } else if (scene.matchable === false || !Array.isArray(scene.instances) || scene.instances.length < 2) {
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

  if (footrestCapability === 'absent') {
    if (footrestState !== 'not_applicable') {
      rejectScene(scene, 'absent_capability_requires_not_applicable_state')
      continue
    }
    selectedResult = nearestAnchor(scene.azimuth, anchor =>
      anchorCapability(anchor) === 'absent' && anchor.footrestState === 'not_applicable')
    if (!selectedResult && productIndex.absentFallback) {
      selectedResult = nearestAnchor(scene.azimuth, anchor =>
        anchorCapability(anchor) === 'present'
        && anchor.footrestState === productIndex.absentFallback.sourceFootrestState)
      capabilityFallback = Boolean(selectedResult)
      fallbackReason = productIndex.absentFallback.reason
    }
  } else {
    selectedResult = nearestAnchor(scene.azimuth, anchor =>
      anchorCapability(anchor) === footrestCapability && anchor.footrestState === footrestState)
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

    const review = mirrored
      || capabilityFallback
      || (!footrestAssumedRetracted && (
        scene.status !== 'auto'
        || scene.confidence < 0.85
        || scene.footrest?.confidence < 0.85
        || (footrestState !== 'not_applicable' && scene.footrest?.visibility < 0.5)
      ))
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
      status: review ? 'review' : 'auto',
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
  version: 6,
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
