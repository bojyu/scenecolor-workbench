import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('defaults fully invisible footrests to retracted while keeping ambiguous visibility blocked', () => {
  const root = mkdtempSync(join(tmpdir(), 'chair-skill-matcher-'))
  const scenesPath = join(root, 'scenes.json')
  const indexPath = join(root, 'index.json')
  const outputPath = join(root, 'output.json')
  const matcherPath = resolve(process.cwd(), 'skills/chair-angle-matcher/scripts/match-scenes.mjs')

  const scenes = { cases: [
    {
      scenePath: 'scenes/absent.jpg', angle: 'right', azimuth: 90, confidence: 0.98,
      imageFacingDirection: 'right',
      matchable: true, status: 'auto', footrest: {
        capability: 'absent', state: 'not_applicable', visibility: 1, confidence: 0.98,
      },
    },
    {
      scenePath: 'scenes/unknown.jpg', angle: 'right', azimuth: 90, confidence: 0.98,
      imageFacingDirection: 'right',
      matchable: true, status: 'review', footrest: {
        capability: 'unknown', state: 'unknown', visibility: 0, confidence: 0.99,
      },
    },
    {
      scenePath: 'scenes/ambiguous.jpg', angle: 'right', azimuth: 90, confidence: 0.98,
      imageFacingDirection: 'right',
      matchable: true, status: 'review', footrest: {
        capability: 'unknown', state: 'unknown', visibility: 0.25, confidence: 0.99,
      },
    },
    {
      scenePath: 'scenes/coarse.jpg', angle: 'right', azimuth: 90, confidence: 0.98,
      imageFacingDirection: 'right', angleObservability: 'coarse',
      matchable: true, status: 'review', footrest: {
        capability: 'present', state: 'retracted', visibility: 0.9, confidence: 0.99,
      },
    },
    {
      scenePath: 'scenes/multi.jpg', angle: 'multiple', azimuth: null, confidence: 0.98,
      imageFacingDirection: 'multiple',
      matchable: true, status: 'review', sceneMode: 'multi_same_model',
      instances: [
        { id: 'front', angle: 'front', azimuth: 0, imageFacingDirection: 'center' },
        { id: 'right', angle: 'right', azimuth: 90, imageFacingDirection: 'right' },
      ],
      multiView: {
        primaryAnchorKey: 'front_right_20_retracted',
        supportingAnchorKeys: ['front_0_retracted', 'right_90_retracted'],
      },
      footrest: { capability: 'present', state: 'retracted', visibility: 0.9, confidence: 0.98 },
    },
  ] }
  const index = {
    footrestCapability: 'present', clusterToleranceDegrees: 15, groups: ['white'],
    absentFallback: { sourceFootrestState: 'retracted', status: 'review', reason: 'review fallback' },
    invisibleFootrestFallback: {
      maxVisibility: 0, minInvisibilityConfidence: 0.95, minAngleConfidence: 0.7,
      sourceFootrestState: 'retracted', status: 'auto', reason: 'invisible defaults to retracted',
    },
    angles: [
      { key: 'front_0_retracted', angle: 'front', azimuth: 0, imageFacingDirection: 'center', footrestState: 'retracted', anchors: { white: 'products/front.jpg' } },
      { key: 'front_right_20_retracted', angle: 'front_right', azimuth: 20, imageFacingDirection: 'right', footrestState: 'retracted', anchors: { white: 'products/oblique.jpg' } },
      { key: 'right_90_retracted', angle: 'right', azimuth: 90, imageFacingDirection: 'right', footrestState: 'retracted', anchors: { white: 'products/right.jpg' } },
    ],
  }

  try {
    writeFileSync(scenesPath, JSON.stringify(scenes))
    writeFileSync(indexPath, JSON.stringify(index))
    execFileSync(process.execPath, [matcherPath, scenesPath, indexPath, outputPath])
    const output = JSON.parse(readFileSync(outputPath, 'utf8'))
    const absent = output.matches.find((item: any) => item.scenePath === 'scenes/absent.jpg')
    const unknown = output.matches.find((item: any) => item.scenePath === 'scenes/unknown.jpg')
    const ambiguous = output.matches.find((item: any) => item.scenePath === 'scenes/ambiguous.jpg')
    const coarse = output.matches.find((item: any) => item.scenePath === 'scenes/coarse.jpg')
    const multi = output.matches.find((item: any) => item.scenePath === 'scenes/multi.jpg')

    assert.equal(absent.status, 'review')
    assert.equal(absent.capabilityFallback, true)
    assert.equal(absent.productPath, 'products/right.jpg')
    assert.equal(unknown.status, 'auto')
    assert.equal(unknown.productPath, 'products/right.jpg')
    assert.equal(unknown.angle, 'right')
    assert.equal(unknown.anchorKey, 'right_90_retracted')
    assert.equal(unknown.footrestState, 'retracted')
    assert.equal(unknown.observedFootrestState, 'unknown')
    assert.equal(unknown.footrestAssumedRetracted, true)
    assert.equal(ambiguous.status, 'unmatched')
    assert.equal(ambiguous.productPath, null)
    assert.equal(coarse.status, 'unmatched')
    assert.equal(coarse.reason, 'angle_observability_not_exact')
    assert.equal(coarse.productPath, null)
    assert.equal(multi.status, 'review')
    assert.equal(multi.referenceMode, 'multi_view')
    assert.equal(multi.productPath, 'products/oblique.jpg')
    assert.deepEqual(multi.supportingReferences.map((item: any) => item.productPath), [
      'products/front.jpg',
      'products/right.jpg',
    ])
    assert.equal(output.summary.externalApiCalls, 0)
    assert.equal(output.summary.assumedRetractedSceneCount, 1)
    assert.equal(output.summary.assumedRetractedMatchCount, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('keeps the PC003 shallow directions on native non-mirrored anchors', () => {
  const root = mkdtempSync(join(tmpdir(), 'chair-direction-regression-'))
  const outputPath = join(root, 'output.json')
  const matcherPath = resolve(process.cwd(), 'skills/chair-angle-matcher/scripts/match-scenes.mjs')
  const calibrationPath = resolve(process.cwd(), 'skills/chair-angle-matcher/references/calibration-cases.json')
  const indexPath = resolve(process.cwd(), 'skills/chair-angle-matcher/references/product-angle-index.json')

  try {
    execFileSync(process.execPath, [matcherPath, calibrationPath, indexPath, outputPath])
    const output = JSON.parse(readFileSync(outputPath, 'utf8'))
    const whiteMatches = new Map(output.matches
      .filter((item: any) => item.colorGroup === 'white')
      .map((item: any) => [item.scenePath, item]))
    const pc003Left = whiteMatches.get('scenes/PC003-1.png') as any
    const pc003Right = whiteMatches.get('scenes/PC003-3.png') as any
    const pc003WideRight = whiteMatches.get('scenes/PC003.png') as any

    assert.equal(pc003Left.angle, 'front_left')
    assert.equal(pc003Left.imageFacingDirection, 'left')
    assert.equal(pc003Left.anchorKey, 'front_left_330_retracted')
    assert.equal(pc003Left.productPath, 'products/白色/J97A1067.jpg')
    assert.equal(pc003Left.mirrored, false)
    for (const match of [pc003Right, pc003WideRight]) {
      assert.equal(match.angle, 'front_right')
      assert.equal(match.imageFacingDirection, 'right')
      assert.equal(match.anchorKey, 'front_right_20_retracted')
      assert.equal(match.productPath, 'products/白色/J97A1053.jpg')
      assert.equal(match.mirrored, false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects an angle label that conflicts with image-facing direction', () => {
  const root = mkdtempSync(join(tmpdir(), 'chair-direction-guard-'))
  const scenesPath = join(root, 'scenes.json')
  const indexPath = join(root, 'index.json')
  const matcherPath = resolve(process.cwd(), 'skills/chair-angle-matcher/scripts/match-scenes.mjs')

  try {
    writeFileSync(scenesPath, JSON.stringify({ cases: [{
      scenePath: 'scenes/wrong.jpg', angle: 'front_left', azimuth: 330,
      imageFacingDirection: 'right', confidence: 0.95, matchable: true, status: 'auto',
      footrest: { capability: 'present', state: 'retracted', visibility: 1, confidence: 0.95 },
    }] }))
    writeFileSync(indexPath, JSON.stringify({
      footrestCapability: 'present', clusterToleranceDegrees: 15, groups: ['white'],
      angles: [{
        key: 'front_left_330_retracted', angle: 'front_left', azimuth: 330,
        imageFacingDirection: 'left', footrestState: 'retracted',
        anchors: { white: 'products/left.jpg' },
      }],
    }))
    assert.throws(() => execFileSync(process.execPath, [matcherPath, scenesPath, indexPath], { stdio: 'pipe' }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
