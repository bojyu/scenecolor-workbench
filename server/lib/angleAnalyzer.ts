import { readFile } from 'fs/promises'
import sharp from 'sharp'
import { assertProjectPath } from './projectAccess.js'
import { normalizeSceneAngleInput, SceneAngleInput } from './sceneAngles.js'

const DEFAULT_ANGLE_API_URL = 'https://ai.comfly.org/v1/chat/completions'
const DEFAULT_ANGLE_MODEL = 'gemini-3-flash-preview'

export const ANGLE_PROMPT = `Analyze the camera viewing angle of the main chair in this image. Continuous azimuth is the primary result; the named angle is only its semantic range.

Angle definitions use the chair as the center:
- front: 350-359.9 or 0-10 degrees, and only when the chair is nearly bilaterally symmetric
- front_right: more than 10 and less than 80 degrees
- right: 80-100 degrees
- back_right: more than 100 and less than 170 degrees
- back: 170-190 degrees
- back_left: more than 190 and less than 260 degrees
- left: 260-280 degrees
- front_left: more than 280 and less than 350 degrees
- multiple: multiple chairs have different dominant angles
- unknown: the chair is missing or the angle cannot be determined

Strict-front rule: do not label a chair front merely because it is close to frontal. If the two armrests differ in apparent size or overlap, the seat edge converges or slopes, one side panel is more visible, or the backrest outline is asymmetric because of perspective, classify it as front_right/front_left and give its non-zero azimuth. Determine direction from the projected chair-front/seat axis in the final image: use front_right/right when that axis points toward image-right, and front_left/left when it points toward image-left. Never infer direction from the screen position of the nearer armrest alone. Ignore room lines, shadows, wheel rotation, and product styling when deciding azimuth.

Return exactly one JSON object and no Markdown:
{
  "angle": "front|front_right|right|back_right|back|back_left|left|front_left|multiple|unknown",
  "azimuth": 0,
  "elevation": 0,
  "mirrored": false,
  "occlusion": 0.0,
  "confidence": 0.0,
  "chairCount": 1,
  "reason": "Concise visual evidence for the decision"
}

Use azimuth 0-359.9 degrees, elevation -90 to 90 degrees, and occlusion/confidence 0-1. In reason, cite at least two visible geometry cues that support the direction.`

export interface AngleAnalyzerResponse {
  analysis: ReturnType<typeof normalizeSceneAngleInput>
  model: string
  tokenUsage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

export class AngleAnalyzerError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message)
    this.name = 'AngleAnalyzerError'
  }
}

function responseText(data: any): string {
  const content = data?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => typeof part === 'string' ? part : (part?.text || part?.content || ''))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof data?.output_text === 'string') return data.output_text
  throw new AngleAnalyzerError('角度识别接口没有返回文本结果')
}

export function parseAngleAnalysis(text: string): ReturnType<typeof normalizeSceneAngleInput> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new AngleAnalyzerError('角度识别结果不是有效 JSON')
  try {
    return normalizeSceneAngleInput(JSON.parse(cleaned.slice(start, end + 1)) as SceneAngleInput)
  } catch (error: any) {
    if (error instanceof AngleAnalyzerError) throw error
    throw new AngleAnalyzerError(`无法解析角度识别结果: ${error.message}`)
  }
}

export async function analyzeSceneAngleWithModel(
  scenePath: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<AngleAnalyzerResponse> {
  const safePath = assertProjectPath(scenePath)
  const source = await readFile(safePath)
  const image = await sharp(source)
    .rotate()
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, progressive: true })
    .toBuffer()
  const model = process.env.ANGLE_MODEL || DEFAULT_ANGLE_MODEL
  const apiUrl = process.env.ANGLE_API_URL || DEFAULT_ANGLE_API_URL

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: ANGLE_PROMPT },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` } },
        ],
      }],
    }),
    signal,
  })

  if (!response.ok) {
    const details = (await response.text()).slice(0, 800)
    throw new AngleAnalyzerError(`角度识别 API 错误 (${response.status}): ${details}`, response.status)
  }

  const data = await response.json() as any
  return {
    analysis: parseAngleAnalysis(responseText(data)),
    model,
    tokenUsage: data?.usage ? {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    } : undefined,
  }
}
