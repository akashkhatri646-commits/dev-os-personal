import type { NormalizedBlock } from '@/types/documents'

/** Recognised content of one page. */
export interface OcrPage {
  page: number
  text: string
  /** Mean recognition confidence for the page, 0..1. */
  confidence: number
  blocks: NormalizedBlock[]
  /** Share of blocks recognised as handwriting, 0..1, when the engine reports it. */
  handwrittenRatio?: number
}

export interface OcrResult {
  /** Identifier stored on the document, e.g. `textract`, `pdf-text`, `hl7-parser`. */
  engine: string
  pages: OcrPage[]
}

/** The original document handed to a recognition engine. */
export interface OcrInput {
  bytes: Buffer
  mimeType: string
  /** Page count when known (PDFs); engines may use it to choose a sync or async API. */
  pageCount: number | null
}

/**
 * A text-recognition engine for scans and faxes. Adapters (AWS Textract, Google Document AI) run
 * inside the compliant PHI boundary and are only ever called after a valid consent check. They
 * return pages with block ids of the form `p<page>b<index>` and bounding boxes normalised to 0..1.
 */
export interface OcrClient {
  recognize(input: OcrInput): Promise<OcrResult>
}

/** A page of digital (non-scanned) text. Its confidence is not a recognition estimate. */
export const DIGITAL_TEXT_CONFIDENCE = { text: 1, hl7: 1, pdfTextLayer: 0.99 } as const
