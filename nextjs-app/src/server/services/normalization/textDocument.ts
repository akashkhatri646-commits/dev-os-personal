import { DIGITAL_TEXT_CONFIDENCE, type OcrPage } from '@/types/ocr'

/**
 * Turns a clinical note into one page of citeable blocks: one block per paragraph (split on blank
 * lines), ids `p1b<n>`. Notes are not OCRed, so the confidence is 1.
 */
export function textToPages(raw: string): OcrPage[] {
  const normalised = raw.replace(/^﻿/, '').replace(/\r\n|\r/g, '\n')
  const paragraphs = normalised
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)

  const blocks = paragraphs.map((text, index) => ({
    id: `p1b${index + 1}`,
    text,
    confidence: DIGITAL_TEXT_CONFIDENCE.text,
  }))
  return [
    {
      page: 1,
      text: blocks.map((block) => block.text).join('\n\n'),
      confidence: DIGITAL_TEXT_CONFIDENCE.text,
      blocks,
    },
  ]
}
