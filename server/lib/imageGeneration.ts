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

const IMAGE_ASPECT_RATIO_SET = new Set<string>(IMAGE_ASPECT_RATIOS)

export function normalizeImageAspectRatio(value: unknown): ImageAspectRatio {
  return typeof value === 'string' && IMAGE_ASPECT_RATIO_SET.has(value)
    ? value as ImageAspectRatio
    : 'auto'
}

export function buildImageGenerationConfig(aspectRatio: ImageAspectRatio): {
  image_config: { aspect_ratio: ImageAspectRatio }
} {
  return {
    image_config: {
      aspect_ratio: aspectRatio,
    },
  }
}
