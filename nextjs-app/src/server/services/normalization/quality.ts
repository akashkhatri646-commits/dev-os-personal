import type { OcrPage } from '@/types/ocr'

/** No single page may fall below this recognition confidence, whatever the document average is. */
export const MIN_PAGE_CONFIDENCE = 0.6
/** More than this share of handwritten blocks sends a document to review. */
export const MAX_HANDWRITTEN_RATIO = 0.15

export type QualityVerdict =
  | { ok: true; confidence: number }
  | { ok: false; reason: 'low_ocr_quality' | 'handwriting'; confidence: number }

/**
 * Document confidence: the page confidences averaged by how much text each page holds, so a nearly
 * empty page cannot drag down (or prop up) the result. A document with no text at all scores 0.
 */
export function weightedConfidence(pages: readonly OcrPage[]): number {
  const totalChars = pages.reduce((sum, page) => sum + page.text.length, 0)
  if (totalChars === 0) return 0
  const weighted = pages.reduce((sum, page) => sum + page.confidence * page.text.length, 0)
  return Math.round((weighted / totalChars) * 1000) / 1000
}

/**
 * The quality floor (spec 04 §4): reject, rather than guess, when recognition is poor. Applies the
 * same rules to every source of text, so digital text passes only because it is genuinely readable.
 */
export function assessQuality(pages: readonly OcrPage[], floor: number): QualityVerdict {
  const confidence = weightedConfidence(pages)
  if (pages.length === 0 || confidence < floor || pages.some((page) => page.confidence < MIN_PAGE_CONFIDENCE)) {
    return { ok: false, reason: 'low_ocr_quality', confidence }
  }
  const blocks = pages.reduce((sum, page) => sum + page.blocks.length, 0)
  const handwritten = pages.reduce((sum, page) => sum + (page.handwrittenRatio ?? 0) * page.blocks.length, 0)
  if (blocks > 0 && handwritten / blocks > MAX_HANDWRITTEN_RATIO) {
    return { ok: false, reason: 'handwriting', confidence }
  }
  return { ok: true, confidence }
}
