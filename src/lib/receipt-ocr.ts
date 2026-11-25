import { copyFile, mkdtemp, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import sharp from 'sharp'
import { createWorker, OEM } from 'tesseract.js'

const maxPixels = 8_000_000
export const maxReceiptPages = 5

export class ReceiptOcrError extends Error {}

async function recognizeImages(images: Buffer[]) {
  if (!images.length) return []
  const root = join(process.cwd(), 'node_modules', '@tesseract.js-data')
  const languageDirectory = await mkdtemp(join(tmpdir(), 'receipt-languages-'))
  const languages = ['kor', 'eng']
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined
  try {
    for (const code of languages) {
      const file = code + '.traineddata.gz'
      await copyFile(join(root, code, '4.0.0_best_int', file), join(languageDirectory, file))
    }
    worker = await createWorker('kor+eng', OEM.LSTM_ONLY, { langPath: languageDirectory, cacheMethod: 'none', gzip: true })
    const results = []
    for (const image of images) {
      const { data } = await worker.recognize(image)
      results.push({ text: data.text.trim(), confidence: data.confidence, method: 'ocr' as const })
    }
    return results
  } finally {
    await worker?.terminate()
    await Promise.allSettled(languages.map((code) => unlink(join(languageDirectory, code + '.traineddata.gz'))))
    await rmdir(languageDirectory)
  }
}

export async function recognizeReceipt(data: Buffer, extension: string) {
  if (extension !== 'pdf') {
    const image = await sharp(data, { limitInputPixels: maxPixels }).rotate().png().toBuffer()
    return recognizeImages([image])
  }
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const pdf = getDocument({
    data: Uint8Array.from(data), maxImageSize: maxPixels, useSystemFonts: false,
    standardFontDataUrl: join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/',
  })
  try {
    const document = await pdf.promise
    if (document.numPages > maxReceiptPages) throw new ReceiptOcrError('OCR_PAGE_LIMIT')
    const pages: ({ text: string; confidence: number | null; method: 'embedded' | 'ocr' } | null)[] = []
    const images: Buffer[] = []
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number)
      const content = await page.getTextContent()
      const text = content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim()
      if (text) {
        pages.push({ text, confidence: null, method: 'embedded' })
        continue
      }
      const initial = page.getViewport({ scale: 1 })
      const scale = Math.min(2.5, Math.sqrt(maxPixels / (initial.width * initial.height)))
      const viewport = page.getViewport({ scale })
      const canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)))
      await page.render({
        canvas: null, canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D, viewport,
      }).promise
      images.push(canvas.toBuffer('image/png'))
      pages.push(null)
    }
    const detected = await recognizeImages(images)
    let index = 0
    return pages.map((page) => page ?? detected[index++])
  } finally {
    await pdf.destroy()
  }
}
