import sharp from 'sharp'

const DEFAULT_MAX_EDGE = 2048
const PASSTHROUGH_MAX_BYTES = 1024 * 1024
const DEFAULT_PREPARED_MAX_BYTES = 2_500_000
export const RELAY_INPUT_AGGREGATE_MAX_BYTES = 5_200_000
export const RELAY_INPUT_PER_FILE_MAX_BYTES = 1_200_000

export interface PreparedGenerationInput {
  dataUri: string
  transmittedBytes: number
  optimized: boolean
}

export interface GenerationInputPreparationOptions {
  maxEdge?: number
  maxBytes?: number
}

export interface GenerationInputSource {
  source: Buffer
  mime: string
}

function mayPassThrough(
  mime: string,
  bytes: number,
  width: number | undefined,
  height: number | undefined,
  orientation: number | undefined,
  maxEdge: number,
  maxBytes: number,
): boolean {
  return (
    (mime === 'image/jpeg' || mime === 'image/webp')
    && bytes <= Math.min(PASSTHROUGH_MAX_BYTES, maxBytes)
    && Boolean(width && height)
    && Math.max(width || 0, height || 0) <= maxEdge
    && (!orientation || orientation === 1)
  )
}

/**
 * Keeps original bytes outside this helper for hashing and geometry, while producing
 * a bounded relay payload. This prevents large catalog originals from turning one
 * generation request into tens of megabytes of base64 JSON.
 */
export async function prepareGenerationInput(
  source: Buffer,
  mime: string,
  options: GenerationInputPreparationOptions = {},
): Promise<PreparedGenerationInput> {
  const maxEdge = Math.max(768, Math.min(DEFAULT_MAX_EDGE, Math.round(options.maxEdge || DEFAULT_MAX_EDGE)))
  const maxBytes = Math.max(400_000, Math.min(DEFAULT_PREPARED_MAX_BYTES, Math.round(options.maxBytes || DEFAULT_PREPARED_MAX_BYTES)))
  if (!source.length) throw new Error('图片数据为空')
  const metadata = await sharp(source).metadata()
  if (!metadata.width || !metadata.height) throw new Error('无法读取图片尺寸')

  if (mayPassThrough(
    mime,
    source.length,
    metadata.width,
    metadata.height,
    metadata.orientation,
    maxEdge,
    maxBytes,
  )) {
    return {
      dataUri: `data:${mime};base64,${source.toString('base64')}`,
      transmittedBytes: source.length,
      optimized: false,
    }
  }

  const render = (edge: number, quality: number) => sharp(source)
    .rotate()
    .resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality, chromaSubsampling: '4:4:4', progressive: true })
    .toBuffer()

  const candidates: Array<[number, number]> = [
    [maxEdge, 88],
    [Math.min(1600, maxEdge), 82],
    [Math.min(1400, maxEdge), 78],
    [Math.min(1200, maxEdge), 74],
    [Math.min(1024, maxEdge), 70],
    [Math.min(896, maxEdge), 66],
  ]
  let prepared: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  for (const [edge, quality] of candidates) {
    prepared = await render(edge, quality)
    if (prepared.length <= maxBytes) break
  }
  if (!prepared.length || prepared.length > maxBytes) {
    throw new Error('参考图压缩后仍超过生成请求大小限制')
  }
  return {
    dataUri: `data:image/jpeg;base64,${prepared.toString('base64')}`,
    transmittedBytes: prepared.length,
    optimized: true,
  }
}

/**
 * Prepares all reference images as one relay payload. Individual image limits are
 * not sufficient because base64 JSON overhead is paid for every reference.
 */
export async function prepareGenerationInputs(
  inputs: GenerationInputSource[],
): Promise<PreparedGenerationInput[]> {
  const initiallyPrepared = await Promise.all(inputs.map(input => (
    prepareGenerationInput(input.source, input.mime)
  )))
  const initialBytes = initiallyPrepared.reduce((total, item) => total + item.transmittedBytes, 0)
  if (initialBytes <= RELAY_INPUT_AGGREGATE_MAX_BYTES) return initiallyPrepared

  const perFileBudget = Math.min(
    RELAY_INPUT_PER_FILE_MAX_BYTES,
    Math.floor(RELAY_INPUT_AGGREGATE_MAX_BYTES / Math.max(1, inputs.length)),
  )
  const constrained = await Promise.all(inputs.map(input => prepareGenerationInput(
    input.source,
    input.mime,
    { maxEdge: 1536, maxBytes: perFileBudget },
  )))
  const constrainedBytes = constrained.reduce((total, item) => total + item.transmittedBytes, 0)
  if (constrainedBytes > RELAY_INPUT_AGGREGATE_MAX_BYTES) {
    throw new Error('参考图总大小超过生成请求限制，请减少辅助参考图或压缩原图')
  }
  return constrained
}
