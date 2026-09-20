export const IMAGE_ASPECT_RATIOS = [
  'auto',
  '1:1',
  '1:4',
  '4:1',
  '1:8',
  '8:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
] as const

export type ImageAspectRatio = typeof IMAGE_ASPECT_RATIOS[number]

export const IMAGE_GENERATION_MODELS = ['nano-banana-2', 'gpt-image-2'] as const
export type ImageGenerationModel = typeof IMAGE_GENERATION_MODELS[number]

export const IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const
export type ImageResolution = typeof IMAGE_RESOLUTIONS[number]

export interface ImageDimensions {
  width: number
  height: number
}

export interface DisplayImageMetadata {
  width?: number
  height?: number
  autoOrient?: {
    width?: number
    height?: number
  }
}

export interface AutoImageGeometry extends ImageDimensions {
  aspectRatio: string
  size: string
  exact: boolean
}

export interface ImageGenerationConfig {
  image_config: {
    aspect_ratio: string
    image_size: ImageResolution
  }
  size?: string
}

export interface ImageOutputGeometryValidation {
  ratioMatches: boolean
  sizeMatches: boolean
  valid: boolean
}

export class ImageGenerationConfigError extends Error {
  readonly statusCode = 422
  readonly code = 'image_geometry_unavailable'

  constructor(message: string) {
    super(message)
    this.name = 'ImageGenerationConfigError'
  }
}

interface ImageGenerationConfigOptions {
  model?: ImageGenerationModel
  sourceDimensions?: ImageDimensions
}

const IMAGE_ASPECT_RATIO_SET = new Set<string>(IMAGE_ASPECT_RATIOS)
const IMAGE_GENERATION_MODEL_SET = new Set<string>(IMAGE_GENERATION_MODELS)
const IMAGE_RESOLUTION_SET = new Set<string>(IMAGE_RESOLUTIONS)

const GPT_IMAGE_2_ALIGNMENT = 16
const GPT_IMAGE_2_MIN_PIXELS = 655_360
const GPT_IMAGE_2_MAX_PIXELS = 8_294_400
const GPT_IMAGE_2_MAX_EDGE = 3840
const GPT_IMAGE_2_MAX_ASPECT_RATIO = 3
// GPT Image 2 can return a canvas that is a few pixels off the requested ratio
// (for example 1123x1400 for 4:5). Keep this provider-normalization allowance
// narrow so that genuine composition/canvas mismatches are still rejected.
export const GPT_IMAGE_2_OUTPUT_RATIO_TOLERANCE = 0.005
const TARGET_LONG_EDGE_BY_RESOLUTION: Record<ImageResolution, number> = {
  '1K': 1024,
  '2K': 2048,
  '4K': 3840,
}

const NANO_BANANA_MODEL_BY_RESOLUTION: Record<ImageResolution, string> = {
  '1K': 'gemini-3.1-flash-image-preview',
  '2K': 'gemini-3.1-flash-image-preview-2k',
  '4K': 'gemini-3.1-flash-image-preview-4k',
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(Math.round(left))
  let b = Math.abs(Math.round(right))
  while (b) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return a || 1
}

function leastCommonMultiple(left: number, right: number): number {
  return Math.abs(left * right) / greatestCommonDivisor(left, right)
}

function validDimensions(dimensions: Partial<ImageDimensions> | undefined): dimensions is ImageDimensions {
  return Boolean(
    dimensions
    && typeof dimensions.width === 'number'
    && typeof dimensions.height === 'number'
    && Number.isFinite(dimensions.width)
    && Number.isFinite(dimensions.height)
    && dimensions.width > 0
    && dimensions.height > 0,
  )
}

function aligned(value: number): number {
  return Math.max(GPT_IMAGE_2_ALIGNMENT, Math.round(value / GPT_IMAGE_2_ALIGNMENT) * GPT_IMAGE_2_ALIGNMENT)
}

function reducedAspectRatio(dimensions: ImageDimensions): string {
  const width = Math.round(dimensions.width)
  const height = Math.round(dimensions.height)
  const divisor = greatestCommonDivisor(width, height)
  return `${width / divisor}:${height / divisor}`
}

function resolveExactAlignedGeometry(
  source: ImageDimensions,
  resolution: ImageResolution,
): AutoImageGeometry | undefined {
  const sourceWidth = Math.round(source.width)
  const sourceHeight = Math.round(source.height)
  const divisor = greatestCommonDivisor(sourceWidth, sourceHeight)
  const ratioWidth = sourceWidth / divisor
  const ratioHeight = sourceHeight / divisor
  const widthAlignment = GPT_IMAGE_2_ALIGNMENT / greatestCommonDivisor(ratioWidth, GPT_IMAGE_2_ALIGNMENT)
  const heightAlignment = GPT_IMAGE_2_ALIGNMENT / greatestCommonDivisor(ratioHeight, GPT_IMAGE_2_ALIGNMENT)
  const ratioMultiplier = leastCommonMultiple(widthAlignment, heightAlignment)
  const baseWidth = ratioWidth * ratioMultiplier
  const baseHeight = ratioHeight * ratioMultiplier
  const baseLongEdge = Math.max(baseWidth, baseHeight)
  const basePixels = baseWidth * baseHeight
  const minimumMultiplier = Math.ceil(Math.sqrt(GPT_IMAGE_2_MIN_PIXELS / basePixels))
  const maximumMultiplier = Math.floor(Math.min(
    GPT_IMAGE_2_MAX_EDGE / baseLongEdge,
    Math.sqrt(GPT_IMAGE_2_MAX_PIXELS / basePixels),
  ))
  if (maximumMultiplier < Math.max(1, minimumMultiplier)) return undefined

  const desiredMultiplier = Math.round(TARGET_LONG_EDGE_BY_RESOLUTION[resolution] / baseLongEdge)
  const multiplier = Math.min(
    maximumMultiplier,
    Math.max(Math.max(1, minimumMultiplier), desiredMultiplier),
  )
  const width = baseWidth * multiplier
  const height = baseHeight * multiplier
  return {
    width,
    height,
    aspectRatio: reducedAspectRatio({ width, height }),
    size: `${width}x${height}`,
    exact: true,
  }
}

function resolveNearestAlignedGeometry(
  source: ImageDimensions,
  resolution: ImageResolution,
): AutoImageGeometry {
  const sourceWidth = Math.round(source.width)
  const sourceHeight = Math.round(source.height)
  const landscape = sourceWidth >= sourceHeight
  const longToShortRatio = Math.max(sourceWidth, sourceHeight) / Math.min(sourceWidth, sourceHeight)
  const targetLongEdge = TARGET_LONG_EDGE_BY_RESOLUTION[resolution]
  let best: { longEdge: number; shortEdge: number; ratioError: number; targetDistance: number } | undefined

  for (let longEdge = GPT_IMAGE_2_ALIGNMENT; longEdge <= GPT_IMAGE_2_MAX_EDGE; longEdge += GPT_IMAGE_2_ALIGNMENT) {
    const shortEdge = aligned(longEdge / longToShortRatio)
    const pixels = longEdge * shortEdge
    if (
      shortEdge > longEdge
      || pixels < GPT_IMAGE_2_MIN_PIXELS
      || pixels > GPT_IMAGE_2_MAX_PIXELS
    ) continue

    const ratioError = Math.abs(longEdge / shortEdge - longToShortRatio) / longToShortRatio
    const targetDistance = Math.abs(longEdge - targetLongEdge)
    const candidate = { longEdge, shortEdge, ratioError, targetDistance }
    if (!best) {
      best = candidate
      continue
    }
    const candidateWithinTolerance = candidate.ratioError <= 0.001
    const bestWithinTolerance = best.ratioError <= 0.001
    if (
      (candidateWithinTolerance && !bestWithinTolerance)
      || (candidateWithinTolerance && bestWithinTolerance && candidate.targetDistance < best.targetDistance)
      || (
        !candidateWithinTolerance
        && !bestWithinTolerance
        && (
          candidate.ratioError < best.ratioError
          || (candidate.ratioError === best.ratioError && candidate.targetDistance < best.targetDistance)
        )
      )
    ) {
      best = candidate
    }
  }

  if (!best) {
    throw new ImageGenerationConfigError('Image 2 Auto 无法为图1计算合法输出尺寸，请改用固定比例')
  }

  const width = landscape ? best.longEdge : best.shortEdge
  const height = landscape ? best.shortEdge : best.longEdge
  return {
    width,
    height,
    aspectRatio: reducedAspectRatio({ width, height }),
    size: `${width}x${height}`,
    exact: width * sourceHeight === height * sourceWidth,
  }
}

export function resolveDisplayImageDimensions(metadata: DisplayImageMetadata): ImageDimensions | undefined {
  const oriented = metadata.autoOrient
  if (validDimensions(oriented)) {
    return {
      width: Math.round(oriented.width),
      height: Math.round(oriented.height),
    }
  }
  if (!validDimensions(metadata)) return undefined
  return {
    width: Math.round(metadata.width),
    height: Math.round(metadata.height),
  }
}

export function resolveGptImage2AutoGeometry(
  sourceDimensions: ImageDimensions,
  resolution: ImageResolution,
): AutoImageGeometry {
  if (!validDimensions(sourceDimensions)) {
    throw new ImageGenerationConfigError('Image 2 Auto 无法读取图1尺寸，请检查图1文件')
  }
  const source = {
    width: Math.round(sourceDimensions.width),
    height: Math.round(sourceDimensions.height),
  }
  const longToShortRatio = Math.max(source.width, source.height) / Math.min(source.width, source.height)
  if (longToShortRatio > GPT_IMAGE_2_MAX_ASPECT_RATIO) {
    throw new ImageGenerationConfigError('Image 2 Auto 暂不支持超过 3:1 的图1比例，请改用固定比例')
  }
  return resolveExactAlignedGeometry(source, resolution)
    ?? resolveNearestAlignedGeometry(source, resolution)
}

export function imageAspectRatiosMatch(
  expected: ImageDimensions,
  actual: ImageDimensions,
  tolerance = 0.001,
): boolean {
  if (!validDimensions(expected) || !validDimensions(actual)) return false
  const expectedRatio = expected.width / expected.height
  const actualRatio = actual.width / actual.height
  return Math.abs(actualRatio - expectedRatio) / expectedRatio <= tolerance
}

export function validateImageOutputGeometry(
  expected: ImageDimensions,
  actual: ImageDimensions,
): ImageOutputGeometryValidation {
  const ratioMatches = imageAspectRatiosMatch(
    expected,
    actual,
    GPT_IMAGE_2_OUTPUT_RATIO_TOLERANCE,
  )
  const sizeMatches = validDimensions(expected)
    && validDimensions(actual)
    && Math.round(expected.width) === Math.round(actual.width)
    && Math.round(expected.height) === Math.round(actual.height)
  return {
    ratioMatches,
    sizeMatches,
    // Auto promises the source aspect ratio. A provider may return the same ratio
    // at another pixel size; the route normalizes that image to the requested
    // resolution before saving instead of discarding an otherwise valid result.
    valid: ratioMatches,
  }
}

export function normalizeImageAspectRatio(value: unknown): ImageAspectRatio {
  return typeof value === 'string' && IMAGE_ASPECT_RATIO_SET.has(value)
    ? value as ImageAspectRatio
    : 'auto'
}

export function normalizeImageGenerationModel(value: unknown): ImageGenerationModel {
  return typeof value === 'string' && IMAGE_GENERATION_MODEL_SET.has(value)
    ? value as ImageGenerationModel
    : 'nano-banana-2'
}

export function normalizeImageResolution(value: unknown): ImageResolution {
  return typeof value === 'string' && IMAGE_RESOLUTION_SET.has(value.toUpperCase())
    ? value.toUpperCase() as ImageResolution
    : '4K'
}

export function resolveRelayImageModel(model: ImageGenerationModel, resolution: ImageResolution): string {
  return model === 'gpt-image-2'
    ? 'gpt-image-2'
    : NANO_BANANA_MODEL_BY_RESOLUTION[resolution]
}

export function buildImageGenerationConfig(
  aspectRatio: ImageAspectRatio,
  resolution: ImageResolution,
  options: ImageGenerationConfigOptions = {},
): ImageGenerationConfig {
  if (options.model === 'gpt-image-2' && aspectRatio === 'auto') {
    if (!validDimensions(options.sourceDimensions)) {
      throw new ImageGenerationConfigError('Image 2 Auto 无法读取图1尺寸，请检查图1文件')
    }
    const geometry = resolveGptImage2AutoGeometry(options.sourceDimensions, resolution)
    return {
      image_config: {
        aspect_ratio: geometry.aspectRatio,
        image_size: resolution,
      },
      size: geometry.size,
    }
  }
  return {
    image_config: {
      aspect_ratio: aspectRatio,
      image_size: resolution,
    },
  }
}
