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

const IMAGE_ASPECT_RATIO_SET = new Set<string>(IMAGE_ASPECT_RATIOS)
const IMAGE_GENERATION_MODEL_SET = new Set<string>(IMAGE_GENERATION_MODELS)
const IMAGE_RESOLUTION_SET = new Set<string>(IMAGE_RESOLUTIONS)

const NANO_BANANA_MODEL_BY_RESOLUTION: Record<ImageResolution, string> = {
  '1K': 'gemini-3.1-flash-image-preview',
  '2K': 'gemini-3.1-flash-image-preview-2k',
  '4K': 'gemini-3.1-flash-image-preview-4k',
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

export function buildImageGenerationConfig(aspectRatio: ImageAspectRatio, resolution: ImageResolution): {
  image_config: { aspect_ratio: ImageAspectRatio; image_size: ImageResolution }
} {
  return {
    image_config: {
      aspect_ratio: aspectRatio,
      image_size: resolution,
    },
  }
}
