import { readFile } from 'fs/promises'
import { basename, dirname, relative, sep } from 'path'
import type { ProjectScanResult } from './projectScanner.js'

export type SkillMatchStatus = 'auto' | 'review' | 'unmatched'
export type FootrestCapability = 'present' | 'absent' | 'unknown'
export type FootrestState = 'retracted' | 'partial' | 'extended' | 'not_applicable' | 'unknown'
export type SkillReferenceMode = 'single' | 'multi_view'

export interface SkillChairInstance {
  id: string
  angle: string
  azimuth: number | null
  confidence: number
  decisiveCue: string
}

export interface SkillSupportingReference {
  anchorKey: string
  productPath: string | null
  angle: string
  azimuth: number | null
}

export interface SkillSceneResult {
  scenePath: string
  angle: string
  azimuth: number | null
  confidence: number
  occlusion: number
  chairCount: number
  matchable: boolean
  status: SkillMatchStatus
  decisiveCue: string
  sceneMode?: 'single' | 'multi_same_model' | 'multi_mixed'
  sameModelConfidence?: number
  instances?: SkillChairInstance[]
  footrest: {
    capability: FootrestCapability
    state: FootrestState
    visibility: number
    confidence: number
    decisiveCue: string
  }
}

export interface SkillMatchResult {
  scenePath: string
  groupName: string
  productPath: string | null
  angle: string
  azimuth: number | null
  footrestCapability: FootrestCapability
  footrestState: FootrestState
  observedFootrestCapability: FootrestCapability
  observedFootrestState: FootrestState
  footrestAssumedRetracted: boolean
  anchorKey: string | null
  mirrored: boolean
  capabilityFallback: boolean
  referenceMode: SkillReferenceMode
  supportingReferences: SkillSupportingReference[]
  angleDifference: number | null
  status: SkillMatchStatus
  reason: string
}

export interface SkillResultSummary {
  sceneCount: number
  matchCount: number
  autoCount: number
  reviewCount: number
  unmatchedCount: number
  mirroredCount: number
  blockedSceneCount: number
  externalApiCalls: number
  extendedSceneCount: number
  retractedSceneCount: number
  unknownSceneCount: number
  absentSceneCount: number
  multiViewSceneCount: number
  multiViewMatchCount: number
  capabilityFallbackCount: number
  assumedRetractedSceneCount: number
  assumedRetractedMatchCount: number
}

type CalibrationCase = Omit<SkillSceneResult, 'scenePath'> & { scenePath: string }

interface CalibrationArtifact {
  cases?: unknown
  results?: unknown
}

interface MatchArtifact {
  matches?: Array<{
    scenePath: string
    colorGroup?: string
    productPath: string | null
    angle: string
    azimuth: number | null
    footrestCapability?: FootrestCapability
    footrestState: FootrestState
    observedFootrestCapability?: FootrestCapability
    observedFootrestState?: FootrestState
    footrestAssumedRetracted?: boolean
    anchorKey: string | null
    mirrored: boolean
    capabilityFallback?: boolean
    referenceMode?: SkillReferenceMode
    supportingReferences?: SkillSupportingReference[]
    angleDifference: number | null
    status: SkillMatchStatus
    reason: string
  }>
  summary?: {
    statusCounts?: Partial<Record<SkillMatchStatus, number>>
    mirroredCount?: number
    blockedSceneCount?: number
    externalApiCalls?: number
    multiViewSceneCount?: number
    multiViewMatchCount?: number
    capabilityFallbackCount?: number
    assumedRetractedSceneCount?: number
    assumedRetractedMatchCount?: number
  }
}

function pathKey(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/')
}

async function parseJson<T>(filePath: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new Error(`Skill 成果文件不存在：${filePath}`)
    throw new Error(`Skill 成果文件读取失败：${error?.message || '未知错误'}`)
  }
}

function normalizeCalibrationCases(artifact: CalibrationArtifact): CalibrationCase[] {
  const sources = [artifact.cases, artifact.results].filter(Array.isArray) as unknown[][]
  for (const candidates of sources) {
    if (!candidates.length) continue
    const normalized = candidates.flatMap(candidate => {
      if (!candidate || typeof candidate !== 'object') return []
      const item = candidate as Record<string, any>
      const footrest = item.footrest
      const valid = typeof item.scenePath === 'string'
        && typeof item.angle === 'string'
        && typeof item.confidence === 'number'
        && typeof item.occlusion === 'number'
        && typeof item.chairCount === 'number'
        && typeof item.matchable === 'boolean'
        && ['auto', 'review', 'unmatched'].includes(item.status)
        && footrest && typeof footrest === 'object'
        && typeof footrest.capability === 'string'
        && typeof footrest.state === 'string'
        && typeof footrest.visibility === 'number'
        && typeof footrest.confidence === 'number'
      if (!valid) return []

      return [{
        ...item,
        decisiveCue: String(item.decisiveCue ?? item.reason ?? ''),
        footrest: {
          ...footrest,
          decisiveCue: String(footrest.decisiveCue ?? footrest.reason ?? ''),
        },
      } as CalibrationCase]
    })
    if (normalized.length === candidates.length) return normalized
  }
  return []
}

async function loadCalibrationCases(localPath: string, fallbackPath: string): Promise<CalibrationCase[]> {
  try {
    const localArtifact = await parseJson<CalibrationArtifact>(localPath)
    const localCases = normalizeCalibrationCases(localArtifact)
    if (localCases.length) return localCases
  } catch (error: any) {
    if (!error?.message?.startsWith('Skill 成果文件不存在')) throw error
  }

  const fallbackArtifact = await parseJson<CalibrationArtifact>(fallbackPath)
  const fallbackCases = normalizeCalibrationCases(fallbackArtifact)
  if (!fallbackCases.length) {
    throw new Error(`Skill 场景成果缺少可兼容的 cases/results 数据：${fallbackPath}`)
  }
  return fallbackCases
}

/**
 * Loads the reviewed chair-angle + retractable-footrest artifacts and resolves
 * every relative image path against the already scanned project. Paths that are
 * not present in the scan are deliberately ignored.
 */
export async function loadChairSkillResults(project: ProjectScanResult): Promise<{
  sceneResults: SkillSceneResult[]
  matches: SkillMatchResult[]
  summary: SkillResultSummary
}> {
  const localSceneResultsPath = `${project.root}/.scenecolor/skill-training/scene-angle-results.json`
  const defaultCalibrationPath = `${project.root}/../skills/chair-angle-matcher/references/calibration-cases.json`
  const matchPath = `${project.root}/.scenecolor/skill-training/footrest-matching-results.json`
  const calibrationCases = await loadCalibrationCases(localSceneResultsPath, defaultCalibrationPath)
  const matchArtifact = await parseJson<MatchArtifact>(matchPath)

  const scenePaths = new Map(project.scenes.map(path => [pathKey(project.root, path), path]))
  const productPaths = new Map(project.products.map(path => [pathKey(project.root, path), path]))

  const sceneResults = calibrationCases.flatMap(item => {
    const scenePath = scenePaths.get(item.scenePath)
    return scenePath ? [{ ...item, scenePath }] : []
  })

  const matches = (matchArtifact.matches || []).flatMap(item => {
    const scenePath = scenePaths.get(item.scenePath)
    if (!scenePath) return []
    const productPath = item.productPath ? productPaths.get(item.productPath) || null : null
    return [{
      ...item,
      scenePath,
      productPath,
      footrestCapability: item.footrestCapability ?? 'unknown',
      observedFootrestCapability: item.observedFootrestCapability ?? item.footrestCapability ?? 'unknown',
      observedFootrestState: item.observedFootrestState ?? item.footrestState,
      footrestAssumedRetracted: item.footrestAssumedRetracted ?? false,
      capabilityFallback: item.capabilityFallback ?? false,
      referenceMode: item.referenceMode ?? 'single',
      supportingReferences: (item.supportingReferences ?? []).map(reference => ({
        ...reference,
        productPath: reference.productPath ? productPaths.get(reference.productPath) || null : null,
      })),
      groupName: productPath ? basename(dirname(productPath)) : (item.colorGroup || '未分组'),
    }]
  })

  const counts = matches.reduce((acc, item) => {
    acc[item.status] += 1
    return acc
  }, { auto: 0, review: 0, unmatched: 0 } as Record<SkillMatchStatus, number>)
  const assumedRetractedScenePaths = new Set(matches
    .filter(item => item.footrestAssumedRetracted && item.status !== 'unmatched')
    .map(item => item.scenePath))
  const footrestCounts = sceneResults.reduce((acc, item) => {
    if (item.footrest.capability === 'absent') acc.absent += 1
    else if (item.footrest.state === 'extended') acc.extended += 1
    else if (item.footrest.state === 'retracted') acc.retracted += 1
    else if (assumedRetractedScenePaths.has(item.scenePath)) acc.assumedRetracted += 1
    else acc.unknown += 1
    return acc
  }, { extended: 0, retracted: 0, assumedRetracted: 0, unknown: 0, absent: 0 })

  return {
    sceneResults,
    matches,
    summary: {
      sceneCount: sceneResults.length,
      matchCount: matches.length,
      autoCount: counts.auto,
      reviewCount: counts.review,
      unmatchedCount: counts.unmatched,
      mirroredCount: matchArtifact.summary?.mirroredCount ?? matches.filter(item => item.mirrored).length,
      blockedSceneCount: matchArtifact.summary?.blockedSceneCount ?? 0,
      externalApiCalls: matchArtifact.summary?.externalApiCalls ?? 0,
      extendedSceneCount: footrestCounts.extended,
      retractedSceneCount: footrestCounts.retracted,
      unknownSceneCount: footrestCounts.unknown,
      absentSceneCount: footrestCounts.absent,
      multiViewSceneCount: matchArtifact.summary?.multiViewSceneCount
        ?? new Set(matches.filter(item => item.referenceMode === 'multi_view').map(item => item.scenePath)).size,
      multiViewMatchCount: matchArtifact.summary?.multiViewMatchCount
        ?? matches.filter(item => item.referenceMode === 'multi_view' && item.status !== 'unmatched').length,
      capabilityFallbackCount: matchArtifact.summary?.capabilityFallbackCount
        ?? matches.filter(item => item.capabilityFallback).length,
      assumedRetractedSceneCount: matchArtifact.summary?.assumedRetractedSceneCount
        ?? footrestCounts.assumedRetracted,
      assumedRetractedMatchCount: matchArtifact.summary?.assumedRetractedMatchCount
        ?? matches.filter(item => item.footrestAssumedRetracted && item.status !== 'unmatched').length,
    },
  }
}
