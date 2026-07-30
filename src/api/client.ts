import {
  AnalyzeSceneAnglesResponse,
  AnalyzeProductAnglesResponse,
  AngleMatch,
  GenerateRequest,
  GenerateResponse,
  GenerationAttemptSummary,
  ScanFolderRequest,
  ScanFolderResponse,
  SceneAngleAnalysis,
  ProductAngleAnalysis,
  LoadSkillResultsResponse,
  CodexSkillRecognitionResponse,
  AiRuntimeStatus,
  RuntimeSelection,
  InlineSkillTrainingResponse,
  ReferenceTrainingInput,
  SkillTrainingReport,
  SkillTrainingPublishResponse,
  SkillTrainingReviewInput,
  SkillTrainingReviewResponse,
  VerificationRunResponse,
} from '../types'

const BASE = '/api'

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init)
  let data: any
  try {
    data = await res.json()
  } catch {
    throw new Error(`服务返回了无效响应 (${res.status})`)
  }
  if (!res.ok) throw new Error(data?.error || `请求失败 (${res.status})`)
  return data as T
}

export async function scanFolder(folderPath: string, signal?: AbortSignal): Promise<ScanFolderResponse> {
  return requestJson<ScanFolderResponse>('/scan-folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath } satisfies ScanFolderRequest),
    signal,
  })
}

export async function loadSkillResults(folderPath = '', signal?: AbortSignal): Promise<LoadSkillResultsResponse> {
  return requestJson<LoadSkillResultsResponse>('/load-skill-results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath }),
    signal,
  })
}

export async function getAiRuntimeStatus(signal?: AbortSignal): Promise<AiRuntimeStatus> {
  const data = await requestJson<{ success: boolean; runtime: AiRuntimeStatus }>('/ai-runtime/status', {
    method: 'GET',
    signal,
  })
  return data.runtime
}

export async function recognizeAnglesWithCodexSkill(
  folderPath: string,
  runtime: RuntimeSelection,
  signal?: AbortSignal,
): Promise<CodexSkillRecognitionResponse> {
  return requestJson<CodexSkillRecognitionResponse>('/recognize-angles-with-skill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath, runtime }),
    signal,
  })
}

export async function recalculateSkillTraining(
  folderPath: string,
  runtime: RuntimeSelection,
  reviews: SkillTrainingReviewInput[],
  signal?: AbortSignal,
): Promise<SkillTrainingReviewResponse> {
  return requestJson<SkillTrainingReviewResponse>('/recalculate-skill-training', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath, runtime, reviews }),
    signal,
  })
}

export async function publishSkillTraining(
  folderPath: string,
  reviewId: string,
  target: 'skill' | 'database',
  signal?: AbortSignal,
): Promise<SkillTrainingPublishResponse> {
  return requestJson<SkillTrainingPublishResponse>('/publish-skill-training', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath, reviewId, target }),
    signal,
  })
}

export async function saveInlineSkillTraining(
  folderPath: string,
  runtime: RuntimeSelection,
  review: SkillTrainingReviewInput,
  signal?: AbortSignal,
): Promise<InlineSkillTrainingResponse> {
  return requestJson<InlineSkillTrainingResponse>('/save-inline-skill-training', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath, runtime, review }),
    signal,
  })
}

export async function saveReferenceTraining(
  folderPath: string,
  runtime: RuntimeSelection,
  feedback: ReferenceTrainingInput,
): Promise<{ success: boolean }> {
  return requestJson('/save-reference-training', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath, runtime, feedback }),
  })
}

export async function loadSkillTrainingReport(
  folderPath: string,
  runtime: RuntimeSelection,
): Promise<SkillTrainingReport> {
  const response = await requestJson<{ success: boolean; report: SkillTrainingReport }>('/skill-training-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath, runtime }),
  })
  return response.report
}

export async function generate(req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse> {
  return requestJson<GenerateResponse>('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  })
}

export async function listGenerationAttempts(
  folderPath: string,
  mode: 'metadata' | 'audit' = 'metadata',
  signal?: AbortSignal,
): Promise<GenerationAttemptSummary[]> {
  const response = await requestJson<{ success: boolean; attempts: GenerationAttemptSummary[] }>('/generation-attempts/list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath, mode }),
    signal,
  })
  return response.attempts
}

export async function runVerification(
  attemptId: string,
  runtime: RuntimeSelection,
  projectPath?: string,
  signal?: AbortSignal,
): Promise<VerificationRunResponse> {
  return requestJson<VerificationRunResponse>('/verification/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attemptId, runtime, projectPath }),
    signal,
  })
}

export async function getThumbnail(filePath: string, w: number, signal?: AbortSignal): Promise<string> {
  const data = await requestJson<{ success: boolean; data: string }>('/thumbnail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, w }),
    signal,
  })
  return data.data
}

function binaryUrl(path: '/thumbnail' | '/generation-result', filePath: string, params: Record<string, string>): string {
  const query = new URLSearchParams({ path: filePath, ...params })
  return `${BASE}${path}?${query.toString()}`
}

/**
 * Returns a stable browser URL instead of loading a thumbnail into React state as base64.
 * The project root must have been registered through scanFolder before the URL is requested.
 */
export function getThumbnailUrl(filePath: string, w: number): string {
  const width = Math.max(64, Math.min(1280, Math.round(w)))
  return binaryUrl('/thumbnail', filePath, { w: String(width) })
}

/** Returns the original saved result as a streamed/downloadable response. */
export function getResultDownloadUrl(filePath: string): string {
  return binaryUrl('/generation-result', filePath, { download: '1' })
}

export async function analyzeSceneAngles(
  scenePaths: string[],
  apiKey: string,
  signal?: AbortSignal,
): Promise<AnalyzeSceneAnglesResponse> {
  return requestJson<AnalyzeSceneAnglesResponse>('/analyze-scene-angles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenePaths, apiKey }),
    signal,
  })
}

export async function getSceneAngles(scenePaths: string[], signal?: AbortSignal): Promise<SceneAngleAnalysis[]> {
  const data = await requestJson<{ success: boolean; results: SceneAngleAnalysis[] }>('/scene-angles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenePaths }),
    signal,
  })
  return data.results
}

export async function analyzeProductAngles(
  productPaths: string[],
  apiKey: string,
  signal?: AbortSignal,
): Promise<AnalyzeProductAnglesResponse> {
  return requestJson<AnalyzeProductAnglesResponse>('/analyze-product-angles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productPaths, apiKey }),
    signal,
  })
}

export async function getProductAngles(productPaths: string[], signal?: AbortSignal): Promise<ProductAngleAnalysis[]> {
  const data = await requestJson<{ success: boolean; results: ProductAngleAnalysis[] }>('/product-angles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productPaths }),
    signal,
  })
  return data.results
}

export async function autoMatchAngles(folderPath: string, signal?: AbortSignal): Promise<AngleMatch[]> {
  const data = await requestJson<{ success: boolean; matches: AngleMatch[] }>('/auto-match-angles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath }),
    signal,
  })
  return data.matches
}
