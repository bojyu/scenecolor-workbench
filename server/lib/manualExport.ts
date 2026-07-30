import { constants } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

export const DEFAULT_MANUAL_EXPORT_DIR = 'D:\\下载'

function safeExportStem(value: string): string {
  const original = basename(value.trim(), extname(value.trim()))
  const cleaned = original
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || '生成结果').slice(0, 120)
}

export async function exportGeneratedResult(input: {
  sourcePath: string
  preferredFileName: string
  destinationDir?: string
}): Promise<string> {
  const destinationDir = input.destinationDir?.trim()
    || process.env.SCENECOLOR_MANUAL_EXPORT_DIR?.trim()
    || DEFAULT_MANUAL_EXPORT_DIR
  const stem = safeExportStem(input.preferredFileName)
  await mkdir(destinationDir, { recursive: true })

  for (let index = 1; index <= 999_999; index += 1) {
    const suffix = index === 1 ? '' : `-${index}`
    const destinationPath = join(destinationDir, `${stem}${suffix}.png`)
    try {
      await copyFile(input.sourcePath, destinationPath, constants.COPYFILE_EXCL)
      return destinationPath
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw new Error('下载目录中的同名文件过多，请先整理后重试')
}
