#!/usr/bin/env node
import { mkdir, readdir } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import sharp from 'sharp'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff'])

function option(name, fallback) {
  const prefix = `--${name}=`
  const value = process.argv.find(item => item.startsWith(prefix))?.slice(prefix.length)
  return value == null ? fallback : Number(value)
}

function escapeXml(value) {
  return value.replace(/[<>&'\"]/g, character => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  })[character])
}

const inputDirectory = resolve(process.argv[2] || '')
const outputPath = resolve(process.argv[3] || '')
if (!process.argv[2] || !process.argv[3]) {
  throw new Error('Usage: build-contact-sheet.mjs <image-directory> <output.png> [--columns=5] [--tile=300] [--start=0] [--limit=0]')
}

const columns = Math.max(1, Math.round(option('columns', 5)))
const tile = Math.max(120, Math.round(option('tile', 300)))
const start = Math.max(0, Math.round(option('start', 0)))
const requestedLimit = Math.max(0, Math.round(option('limit', 0)))
const labelHeight = Math.max(30, Math.round(tile * 0.14))
const imageHeight = tile - labelHeight

const names = (await readdir(inputDirectory))
  .filter(name => IMAGE_EXTENSIONS.has(extname(name).toLowerCase()))
  .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
const selected = names.slice(start, requestedLimit ? start + requestedLimit : undefined)
if (!selected.length) throw new Error(`No supported images found in ${inputDirectory}`)

const rows = Math.ceil(selected.length / columns)
const composites = []
for (let index = 0; index < selected.length; index += 1) {
  const name = selected[index]
  const image = await sharp(join(inputDirectory, name))
    .rotate()
    .resize(tile, imageHeight, {
      fit: 'contain',
      background: { r: 245, g: 245, b: 245 },
      withoutEnlargement: true,
    })
    .png()
    .toBuffer()
  const x = (index % columns) * tile
  const y = Math.floor(index / columns) * tile
  composites.push({ input: image, left: x, top: y })
  composites.push({
    input: Buffer.from(`<svg width="${tile}" height="${labelHeight}">
      <rect width="100%" height="100%" fill="#111827"/>
      <text x="10" y="${Math.round(labelHeight * 0.68)}" fill="white" font-size="${Math.max(16, Math.round(labelHeight * 0.48))}" font-family="Arial, sans-serif">${escapeXml(basename(name))}</text>
    </svg>`),
    left: x,
    top: y + imageHeight,
  })
}

await mkdir(dirname(outputPath), { recursive: true })
await sharp({
  create: {
    width: columns * tile,
    height: rows * tile,
    channels: 3,
    background: { r: 229, g: 231, b: 235 },
  },
}).composite(composites).png().toFile(outputPath)

console.log(JSON.stringify({ inputDirectory, outputPath, count: selected.length, start, columns, rows }))
