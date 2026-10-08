import 'server-only'
import { AppError } from '@/lib/api/errors'
import { logger } from '@/server/logger'
import type { NormalizedBlock } from '@/types/documents'
import { DIGITAL_TEXT_CONFIDENCE, type OcrPage } from '@/types/ocr'

/** A PDF counts as digital when its text layer holds at least this many characters per page on average. */
export const MIN_CHARS_PER_PAGE = 200

interface TextItem {
  str: string
  transform: number[]
  width: number
  height: number
}

interface Line {
  y: number
  items: TextItem[]
}

export interface PdfTextResult {
  pageCount: number
  /** Present only when the PDF has a usable text layer. */
  pages: OcrPage[] | null
  charsPerPage: number
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const isTextItem = (item: unknown): item is TextItem =>
  typeof item === 'object' && item !== null && 'str' in item && 'transform' in item

/** Groups text items that share a baseline into reading-order lines. */
function toLines(items: TextItem[]): Line[] {
  const sorted = items
    .filter((item) => item.str.trim().length > 0)
    .sort((a, b) => (b.transform[5] ?? 0) - (a.transform[5] ?? 0) || (a.transform[4] ?? 0) - (b.transform[4] ?? 0))

  const lines: Line[] = []
  for (const item of sorted) {
    const y = item.transform[5] ?? 0
    const tolerance = Math.max(2, item.height * 0.5)
    const line = lines.find((candidate) => Math.abs(candidate.y - y) <= tolerance)
    if (line) line.items.push(item)
    else lines.push({ y, items: [item] })
  }
  for (const line of lines) line.items.sort((a, b) => (a.transform[4] ?? 0) - (b.transform[4] ?? 0))
  return lines
}

function lineToBlock(line: Line, pageNumber: number, index: number, width: number, height: number): NormalizedBlock {
  const text = line.items
    .map((item) => item.str)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  const xs = line.items.flatMap((item) => [item.transform[4] ?? 0, (item.transform[4] ?? 0) + item.width])
  const ys = line.items.flatMap((item) => [item.transform[5] ?? 0, (item.transform[5] ?? 0) + item.height])
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)]
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)]
  return {
    id: `p${pageNumber}b${index}`,
    text,
    confidence: DIGITAL_TEXT_CONFIDENCE.pdfTextLayer,
    // PDF y grows upward; bounding boxes are top-left based.
    bbox: [clamp01(x0 / width), clamp01(1 - y1 / height), clamp01(x1 / width), clamp01(1 - y0 / height)],
  }
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error)
/** The library's own message (for example "Cannot find module ...pdf.worker.mjs"); it never contains document text. */
const errorMessage = (error: unknown) => (error instanceof Error ? error.message.slice(0, 300) : '')

/**
 * Loads pdf.js together with its worker. The library normally finds the worker by a computed file path at run time,
 * which hosting bundlers (Netlify) do not trace, so the file is missing from the deployed function and every PDF
 * fails to open. Importing it by name here makes it part of the bundle, and handing it to pdf.js through
 * `globalThis.pdfjsWorker` is the documented way to skip the file lookup.
 */
async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const shared = globalThis as { pdfjsWorker?: unknown }
  if (!shared.pdfjsWorker) {
    // @ts-expect-error pdf.js ships no type declarations for its worker module.
    shared.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
  }
  return pdfjs
}

/**
 * Reads the embedded text layer of a PDF. Returns `pages: null` when the layer is too thin to rely
 * on (a scan), so the caller routes the document to OCR. Corrupt or encrypted files raise
 * `unreadable_document`, which needs a new upload rather than a retry.
 */
export async function extractPdfText(bytes: Buffer): Promise<PdfTextResult> {
  const pdfjs = await loadPdfjs()

  let document
  try {
    document = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    }).promise
  } catch (error) {
    logger.warn({ stage: 'open', error_name: errorName(error), error_message: errorMessage(error) }, 'pdf could not be opened')
    throw new AppError('VALIDATION_FAILED', 'The PDF could not be read.', { reason: 'unreadable_document' })
  }

  try {
    const pages: OcrPage[] = []
    let totalChars = 0
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const items: TextItem[] = []
      for (const item of content.items) if (isTextItem(item)) items.push(item)
      const lines = toLines(items)
      const blocks = lines.map((line, index) => lineToBlock(line, pageNumber, index + 1, viewport.width, viewport.height))
      const text = blocks.map((block) => block.text).join('\n')
      totalChars += text.length
      pages.push({ page: pageNumber, text, confidence: DIGITAL_TEXT_CONFIDENCE.pdfTextLayer, blocks })
      page.cleanup()
    }

    const charsPerPage = document.numPages === 0 ? 0 : totalChars / document.numPages
    return {
      pageCount: document.numPages,
      pages: charsPerPage >= MIN_CHARS_PER_PAGE ? pages : null,
      charsPerPage,
    }
  } catch (error) {
    logger.warn({ stage: 'read', error_name: errorName(error), error_message: errorMessage(error) }, 'pdf text could not be read')
    throw new AppError('VALIDATION_FAILED', 'The PDF could not be read.', { reason: 'unreadable_document' })
  } finally {
    await document.destroy()
  }
}
