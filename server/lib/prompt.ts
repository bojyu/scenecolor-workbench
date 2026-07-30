import type { ImageAspectRatio, ImageDimensions } from './imageGeneration.js'

export interface ReferenceOptions {
  supportingReferenceCount?: number
  aspectRatio?: ImageAspectRatio
  sourceAspectRatio?: string
  outputDimensions?: ImageDimensions
}

export function buildGenerationPrompt(
  additionalInstructions?: string,
  dimensions?: ImageDimensions,
  referenceOptions?: ReferenceOptions,
): string {
  const aspectRatio = referenceOptions?.aspectRatio ?? 'auto'
  const dimensionsNote = aspectRatio === 'auto'
    ? dimensions
      ? referenceOptions?.outputDimensions
        ? `\n6. Preserve Image 1's complete original frame and width-to-height ratio (${referenceOptions.sourceAspectRatio || `${dimensions.width}:${dimensions.height}`}; source ${dimensions.width}×${dimensions.height}). The requested output canvas is exactly ${referenceOptions.outputDimensions.width}×${referenceOptions.outputDimensions.height} pixels. Do not crop, pad, stretch, rotate, or reframe the scene.`
        : `\n6. Preserve Image 1's complete original frame and width-to-height ratio (${dimensions.width}:${dimensions.height}). Do not crop, pad, stretch, rotate, or reframe the scene.`
      : `\n6. Use Image 1's original aspect ratio for the output image.`
    : `\n6. The output image MUST use the ${aspectRatio} aspect ratio while preserving the scene composition.`

  const supportingReferenceCount = Math.max(0, Math.floor(referenceOptions?.supportingReferenceCount ?? 0))
  const referenceInstructions = supportingReferenceCount > 0
    ? `\n7. Image 2 is the primary shallow-oblique product reference. Images 3 through ${supportingReferenceCount + 2} are supporting views of the same product. Use them together to preserve front construction, side thickness, stitching, pillows, armrests, base, color, material, and footrest structure.\n8. When the scene contains multiple chairs, preserve each chair's original instance angle. Do not average, merge, or rotate the chairs to the primary reference angle.`
    : ''

  const basePrompt = `You are a professional product photographer and image editor.

Your task: Replace the product (chair) in Image 1 (the scene photo) with the product (chair) from Image 2 (the reference product photo).

Requirements:
1. Take the chair from Image 2 and copy its color, material texture, and visual properties exactly.
2. Place it into Image 1, replacing the existing chair while maintaining exactly:
   - The original chair's position, angle, and perspective
   - The scene's lighting, shadows, and reflections on and around the chair
   - The background and everything else in the room or scene unchanged
3. The result should look like a professional photograph where only the chair's color or material was swapped.
4. Do not change the scene, room, background, or any other objects.
5. Match the scale and perspective precisely.${dimensionsNote}${referenceInstructions}

Output only the final composited image. Do not add text, a watermark, or an explanation.`

  const extra = additionalInstructions?.trim()
  if (!extra) return basePrompt
  return `${basePrompt}\n\nAdditional user instructions:\n${extra}`
}
