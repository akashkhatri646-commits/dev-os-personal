import { describe, expect, it } from 'vitest'
import { checkLanguage } from '@/server/services/normalization/language'
import {
  MAX_HANDWRITTEN_RATIO,
  MIN_PAGE_CONFIDENCE,
  assessQuality,
  weightedConfidence,
} from '@/server/services/normalization/quality'
import { textToPages } from '@/server/services/normalization/textDocument'
import type { OcrPage } from '@/types/ocr'

const page = (overrides: Partial<OcrPage> = {}): OcrPage => ({
  page: 1,
  text: 'x'.repeat(100),
  confidence: 0.95,
  blocks: [{ id: 'p1b1', text: 'x' }],
  ...overrides,
})

describe('textToPages', () => {
  it('splits a note into one block per paragraph with stable ids', () => {
    const [only, ...rest] = textToPages('Chief complaint: fever.\n\nPlan: antibiotics.\r\n\r\n\r\nReview in one week.')
    expect(rest).toHaveLength(0)
    expect(only?.blocks.map((block) => block.id)).toEqual(['p1b1', 'p1b2', 'p1b3'])
    expect(only?.blocks.map((block) => block.text)).toEqual(['Chief complaint: fever.', 'Plan: antibiotics.', 'Review in one week.'])
    expect(only?.confidence).toBe(1)
  })

  it('handles a single paragraph, a byte-order mark and an empty note', () => {
    expect(textToPages('﻿Just one line')[0]?.blocks).toHaveLength(1)
    expect(textToPages('   ')[0]?.blocks).toHaveLength(0)
    expect(textToPages('   ')[0]?.text).toBe('')
  })
})

describe('weightedConfidence', () => {
  it('weights pages by how much text they hold', () => {
    const value = weightedConfidence([page({ text: 'x'.repeat(900), confidence: 1 }), page({ text: 'x'.repeat(100), confidence: 0 })])
    expect(value).toBe(0.9)
  })

  it('scores a document without text as 0', () => {
    expect(weightedConfidence([])).toBe(0)
    expect(weightedConfidence([page({ text: '' })])).toBe(0)
  })
})

describe('assessQuality (spec 04: reject rather than guess)', () => {
  it('passes good text at and above the floor', () => {
    expect(assessQuality([page({ confidence: 0.8 })], 0.8)).toEqual({ ok: true, confidence: 0.8 })
    expect(assessQuality([page({ confidence: 0.99 })], 0.8).ok).toBe(true)
  })

  it('rejects a document just below the floor', () => {
    const verdict = assessQuality([page({ confidence: 0.79 })], 0.8)
    expect(verdict).toEqual({ ok: false, reason: 'low_ocr_quality', confidence: 0.79 })
  })

  it('rejects when one page is very poor even though the average is fine', () => {
    const pages = [page({ text: 'x'.repeat(5000), confidence: 0.99 }), page({ page: 2, text: 'x'.repeat(50), confidence: MIN_PAGE_CONFIDENCE - 0.01 })]
    expect(weightedConfidence(pages)).toBeGreaterThan(0.8)
    expect(assessQuality(pages, 0.8)).toMatchObject({ ok: false, reason: 'low_ocr_quality' })
  })

  it('rejects a document with no pages or no text', () => {
    expect(assessQuality([], 0.8)).toMatchObject({ ok: false, reason: 'low_ocr_quality' })
    expect(assessQuality([page({ text: '' })], 0.8)).toMatchObject({ ok: false, reason: 'low_ocr_quality' })
  })

  it('rejects documents that are mostly handwriting', () => {
    const blocks = Array.from({ length: 10 }, (_, index) => ({ id: `p1b${index}`, text: 'x' }))
    const handwritten = page({ blocks, handwrittenRatio: MAX_HANDWRITTEN_RATIO + 0.1 })
    expect(assessQuality([handwritten], 0.8)).toMatchObject({ ok: false, reason: 'handwriting' })
    expect(assessQuality([page({ blocks, handwrittenRatio: MAX_HANDWRITTEN_RATIO })], 0.8).ok).toBe(true)
  })

  it('judges handwriting across pages by block count, not page count', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ id: `a${index}`, text: 'x' }))
    const few = [{ id: 'b0', text: 'x' }]
    const pages = [page({ blocks: many, handwrittenRatio: 0 }), page({ page: 2, blocks: few, handwrittenRatio: 1 })]
    expect(assessQuality(pages, 0.8).ok).toBe(true)
  })
})

const ENGLISH =
  'The patient was admitted with fever and cough. Chest examination revealed crepitations at the right base. ' +
  'Blood tests showed raised white cell count. She was treated with intravenous antibiotics and discharged in a stable condition.'
const HINDI =
  'मरीज को बुखार और खांसी की शिकायत के साथ अस्पताल में भर्ती किया गया था। जांच में दाहिने फेफड़े में संक्रमण पाया गया। ' +
  'उन्हें एंटीबायोटिक दवाइयां दी गईं और स्वस्थ होने पर छुट्टी दे दी गई।'

describe('checkLanguage (English only in the MVP)', () => {
  it('accepts English clinical prose', async () => {
    expect(await checkLanguage(ENGLISH)).toEqual({ supported: true })
  })

  it('flags Hindi text as unsupported', async () => {
    const verdict = await checkLanguage(HINDI)
    expect(verdict.supported).toBe(false)
    if (!verdict.supported) expect(verdict.detected).toBe('hin')
  })

  it('does not judge text that is too short to classify', async () => {
    expect(await checkLanguage('मरीज को बुखार')).toEqual({ supported: true })
    expect(await checkLanguage('')).toEqual({ supported: true })
  })

  it('accepts English with a few Hindi terms (code-mixed notes are not auto-rejected on a guess)', async () => {
    expect((await checkLanguage(`${ENGLISH} ${ENGLISH} Advised dawai after khana.`)).supported).toBe(true)
  })
})
