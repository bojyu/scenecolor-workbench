import {
  AnalyzeSceneAnglesResponse,
  AnalyzeProductAnglesResponse,
  AngleMatch,
  GenerateRequest,
  GenerateResponse,
  ScanFolderRequest,
  ScanFolderResponse,
  SceneAngleAnalysis,
  ProductAngleAnalysis,
  LoadSkillResultsResponse,
  CodexSkillRecognitionResponse,
  AiRuntimeStatus,
  RuntimeSelection,
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

export async function generate(req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse> {
  return requestJson<GenerateResponse>('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
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
