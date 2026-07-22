export type ImageAspectRatio =
  | 'auto'
  | '1:1' | '1:4' | '4:1' | '1:8' | '8:1'
  | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4'
  | '9:16' | '16:9' | '21:9'

export type ImageGenerationModel = 'nano-banana-2' | 'gpt-image-2'
export type ImageResolution = '1K' | '2K' | '4K'

export interface GenerateRequest {
  scenePath: string       // local path in folder mode, base64 data URI in manual mode
  productPath: string     // local path in folder mode, base64 data URI in manual mode
  supportingProductPaths?: string[] // optional same-product front/side reference views
  sceneFile?: string      // original file path for naming and saving output
  productFile?: string    // original file path for naming and saving output
  apiKey: string
  model: ImageGenerationModel
  resolution: ImageResolution
  aspectRatio?: ImageAspectRatio // auto follows Image 1; fixed values override its ratio
  customPrompt?: string   // additional instructions appended to the safe base prompt
  version?: number        // version suffix e.g. 2 → 白色-001-v2.png
}

export interface GenerateResponse {
  success: boolean
  image?: string
  savedPath?: string
  cached?: boolean
  error?: string
}

export type WorkflowModule = 'generation' | 'verification' | 'detail-redraw'
export type WorkflowTaskStatus = 'queued' | 'running' | 'waiting-review' | 'completed' | 'failed' | 'cancelled'
export type WorkflowStepStatus = 'pending' | 'active' | 'completed' | 'failed'

export interface WorkflowProgressStep {
  id: string
  label: string
  status: WorkflowStepStatus
  startedAt?: string
  completedAt?: string
}

export interface WorkflowTaskProgress {
  module: WorkflowModule
  status: WorkflowTaskStatus
  stage: string
  stageLabel: string
  percent: number
  steps: WorkflowProgressStep[]
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  error?: string
  attempt: number
}

export interface VerificationQueueItem {
  id: string
  scenePath: string
  productPath: string
  supportingProductPaths: string[]
  outputImage?: string
  sceneImage?: string
  productImage?: string
  savedPath?: string
  version: number
  queuedAt: string
  progress: WorkflowTaskProgress
}

export type DetailRedrawTarget = 'logo' | 'stitching' | 'piping' | 'texture' | 'hardware' | 'other'

export interface DetailRedrawQueueItem {
  id: string
  sourceVerificationId: string
  scenePath: string
  productPath: string
  supportingProductPaths: string[]
  verifiedImage?: string
  sceneImage?: string
  productImage?: string
  savedPath?: string
  version: number
  requestedTargets: DetailRedrawTarget[]
  queuedAt: string
  progress: WorkflowTaskProgress
}

export interface ScanFolderRequest {
  folderPath: string
}

export interface ScanFolderResponse {
  success: boolean
  root?: string
  scenes: string[]
  products: string[]
  productGroups: { name: string; images: string[] }[]
  sceneAngles: SceneAngleAnalysis[]
  productAngles: ProductAngleAnalysis[]
  angleMatches: AngleMatch[]
  error?: string
}

export type FootrestCapability = 'present' | 'absent' | 'unknown'
export type FootrestState = 'retracted' | 'partial' | 'extended' | 'not_applicable' | 'unknown'
export type SkillReferenceMode = 'single' | 'multi_view'
export type AngleObservability = 'exact' | 'coarse' | 'none'
export type CoarseDirection = 'front' | 'right' | 'back' | 'left' | 'unknown'

export interface SkillChairInstance {
  id: string
  angle: SceneAngle
  azimuth: number | null
  confidence: number
  decisiveCue: string
  imageFacingDirection?: 'left' | 'right' | 'center'
  reclineState?: 'upright' | 'reclined' | 'unknown'
  footrest?: SkillSceneResult['footrest']
}

export interface SkillSupportingReference {
  anchorKey: string
  productPath: string | null
  angle: SceneAngle
  azimuth: number | null
}

export interface SkillSceneResult {
  scenePath: string
  angle: SceneAngle
  azimuth: number | null
  confidence: number
  occlusion: number
  chairCount: number
  matchable: boolean
  status: AngleMatchStatus
  decisiveCue: string
  imageFacingDirection?: 'left' | 'right' | 'center' | 'multiple' | 'unknown'
  angleObservability?: AngleObservability
  coarseDirection?: CoarseDirection
  reclineState?: 'upright' | 'reclined' | 'unknown'
  visibleParts?: Record<string, 'full' | 'partial' | 'hidden' | 'unknown'>
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
  angle: SceneAngle
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
  status: AngleMatchStatus
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

export interface LoadSkillResultsResponse {
  success: boolean
  root?: string
  scenes: string[]
  products: string[]
  productGroups: { name: string; images: string[] }[]
  sceneResults: SkillSceneResult[]
  matches: SkillMatchResult[]
  learnedSelections?: Record<string, string[]>
  summary?: SkillResultSummary
  error?: string
}

export interface CodexSkillRecognitionResponse extends LoadSkillResultsResponse {
  recognition?: {
    provider: 'codex-cli'
    providerId: string
    model: string
    reasoningEffort: string
    skillId: string
    callsMade: number
    cachedSceneCount: number
    sceneCount: number
    durationMs: number
    policyHash: string
    contractHash: string
    schemaHash: string
    indexHash: string
    trainingHash: string
    trainingCaseCount: number
  }
}

export interface SkillTrainingReviewInput {
  scenePath: string
  reviewState: 'confirmed' | 'corrected'
  angleObservability?: AngleObservability
  coarseDirection?: CoarseDirection
  azimuth?: number | null
  sceneMode?: 'single' | 'multi_same_model' | 'multi_mixed'
  footrest?: {
    capability: FootrestCapability
    state: FootrestState
    visibility?: number
    confidence?: number
    decisiveCue?: string
  }
  instances?: Array<{
    id: string
    azimuth: number
    confidence?: number
    decisiveCue?: string
    reclineState?: 'upright' | 'reclined' | 'unknown'
    footrest?: SkillSceneResult['footrest']
  }>
  reviewerNote?: string
}

export interface SkillTrainingReviewResponse extends LoadSkillResultsResponse {
  review: { reviewId: string; reviewCount: number; correctedCount: number }
}

export interface InlineSkillTrainingResponse {
  success: boolean
  reviewId: string
  adjusted: SkillSceneResult
  database: { corpusPath: string; writtenCount: number; totalCount: number }
  skill: { corpusPath: string; writtenCount: number; totalCount: number }
}

export interface ReferenceTrainingInput {
  scenePath: string
  selectedProductPaths: string[]
  suggestedProductPaths?: string[]
}

export interface SkillTrainingReport {
  projectCaseCount: number
  skillCaseCount: number
  referencePreferenceCount: number
  inlineReviewCount: number
  activeExampleCount: number
  lastActivityAt: string | null
  correctedByAngle: Record<string, number>
}

export interface SkillTrainingPublishResponse {
  success: boolean
  publication: {
    target: 'skill' | 'database'
    corpusPath: string
    writtenCount: number
    totalCount: number
  }
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export interface RuntimeSelection {
  providerId: string
  model: string
  reasoningEffort: ReasoningEffort
  skillId: string
}

export interface AiRuntimeStatus {
  available: boolean
  authenticated: boolean
  authMethod: string
  version: string
  executable: string
  currentProviderId: string
  currentModel: string
  currentReasoningEffort: ReasoningEffort
  providers: Array<{ id: string; name: string; kind: 'codex-login' | 'custom' }>
  models: Array<{ id: string; name: string; description: string }>
  reasoningEfforts: Array<{ id: ReasoningEffort; name: string; description: string }>
  skills: Array<{ id: string; name: string; description: string }>
  checkedAt: string
  error?: string
}

export interface ProductAngleAnalysis extends Omit<SceneAngleAnalysis, 'scenePath'> {
  productPath: string
}

export type AngleMatchStatus = 'auto' | 'review' | 'unmatched'

export interface AngleMatch {
  scenePath: string
  groupName: string
  productPath: string | null
  sceneAngle: SceneAngle
  productAngle: SceneAngle | null
  angleDifference: number | null
  elevationDifference: number | null
  confidence: number
  status: AngleMatchStatus
  reason: string
  matchedAt: string
}

export interface AnalyzeProductAnglesResponse {
  success: boolean
  results: Array<ProductAngleAnalysis & { cached?: boolean }>
  errors: { productPath: string; error: string }[]
  callsMade: number
  cachedCount: number
  totalTokens: number
  error?: string
}

export type SceneAngle =
  | 'front'
  | 'front_right'
  | 'right'
  | 'back_right'
  | 'back'
  | 'back_left'
  | 'left'
  | 'front_left'
  | 'multiple'
  | 'unknown'

export interface SceneAngleAnalysis {
  scenePath: string
  angle: SceneAngle
  azimuth: number | null
  elevation: number | null
  mirrored: boolean
  occlusion: number
  confidence: number
  chairCount: number
  reason: string
  source: 'model' | 'agent' | 'manual'
  model?: string
  analyzedAt: string
  imageHash: string
  tokenUsage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

export interface AnalyzeSceneAnglesResponse {
  success: boolean
  results: Array<SceneAngleAnalysis & { cached?: boolean }>
  errors: { scenePath: string; error: string }[]
  callsMade: number
  cachedCount: number
  totalTokens: number
  error?: string
}
