import { PDFDocument, StandardFonts } from 'pdf-lib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordRow } from '@/server/pipeline/orchestrator'
import type { OcrClient, OcrResult } from '@/types/ocr'

const { mocks, state } = vi.hoisted(() => ({
  mocks: {
    assertConsentValid: vi.fn(),
    downloadDocument: vi.fn(),
    appendAudit: vi.fn(),
    getOcrClient: vi.fn(),
    updates: vi.fn(),
  },
  state: {
    document: { data: { storage_path: 'org-1/rec-1/file', mime_type: 'application/pdf', page_count: 1 } as unknown, error: null as { message: string } | null },
    updateError: null as { message: string } | null,
  },
}))

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: () => {
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'limit']) chain[method] = () => chain
      chain.maybeSingle = () => Promise.resolve(state.document)
      chain.update = (values: unknown) => {
        mocks.updates(values)
        return { eq: () => Promise.resolve({ error: state.updateError }) }
      }
      return chain
    },
  }),
}))
vi.mock('@/server/config/constants', () => ({ getRuntimeConfig: () => ({ ocrConfidenceFloor: 0.8 }) }))
vi.mock('@/server/services/audit/auditLog', () => ({ appendAudit: mocks.appendAudit }))
vi.mock('@/server/services/consent/ConsentService', () => ({ assertConsentValid: mocks.assertConsentValid }))
vi.mock('@/server/services/storage/documentStorage', () => ({ downloadDocument: mocks.downloadDocument }))
vi.mock('@/server/services/ocr/OcrClient', () => ({ getOcrClient: mocks.getOcrClient }))

import { AppError } from '@/lib/api/errors'
import { normalizeStage } from '@/server/pipeline/stages/normalize'

const baseRecord: RecordRow = {
  id: 'rec-1',
  org_id: 'org-1',
  source_id: 'source-1',
  patient_id: 'patient-1',
  doc_type: 'discharge_summary',
  input_kind: 'pdf',
  data_categories: ['DischargeSummary'],
  status: 'normalizing',
  status_reason: null,
  created_at: '2026-10-07T00:00:00Z',
}
const run = (inputKind: 'pdf' | 'image' | 'hl7v2' | 'text') =>
  normalizeStage({ record: { ...baseRecord, input_kind: inputKind }, job: {} as never })

const ENGLISH =
  'The patient was admitted with fever and cough. Chest examination revealed crepitations at the right base. ' +
  'Blood tests showed raised white cell count. She was treated with intravenous antibiotics and discharged in a stable condition. ' +
  'Follow up in the outpatient clinic after one week with repeat chest radiograph and blood counts.'

async function textPdf(lines: string[]): Promise<Buffer> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([595, 842])
  lines.forEach((line, index) => page.drawText(line, { x: 40, y: 800 - index * 20, size: 9, font }))
  return Buffer.from(await document.save())
}
const blankPdf = async () => {
  const document = await PDFDocument.create()
  document.addPage()
  return Buffer.from(await document.save())
}

const savedDocument = () => mocks.updates.mock.calls[0]?.[0] as Record<string, unknown> | undefined

function ocrResult(confidence: number, extra: Partial<OcrResult['pages'][number]> = {}): OcrResult {
  return {
    engine: 'fake-ocr',
    pages: [{ page: 1, text: ENGLISH, confidence, blocks: [{ id: 'p1b1', text: ENGLISH, confidence }], ...extra }],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.document = { data: { storage_path: 'org-1/rec-1/file', mime_type: 'application/pdf', page_count: 1 }, error: null }
  state.updateError = null
  mocks.assertConsentValid.mockResolvedValue(undefined)
  mocks.appendAudit.mockResolvedValue(undefined)
  mocks.getOcrClient.mockReturnValue(null)
})

describe('normalizeStage: consent guard and bookkeeping', () => {
  it('re-asserts consent before reading any content, and reads nothing when it fails', async () => {
    mocks.assertConsentValid.mockRejectedValue(new AppError('FORBIDDEN', 'no consent', { reason: 'CONSENT_REQUIRED', retryable: false }))
    await expect(run('text')).rejects.toMatchObject({ reason: 'CONSENT_REQUIRED' })
    expect(mocks.downloadDocument).not.toHaveBeenCalled()
    expect(mocks.updates).not.toHaveBeenCalled()
  })

  it('fails a record whose stored document row is missing', async () => {
    state.document = { data: null, error: null }
    expect(await run('text')).toEqual({ kind: 'fail', reason: 'document_missing' })
    expect(mocks.downloadDocument).not.toHaveBeenCalled()
  })

  it('retries when the document cannot be downloaded or the result cannot be saved', async () => {
    mocks.downloadDocument.mockRejectedValue(new AppError('INTERNAL', 'storage down', { retryable: true }))
    await expect(run('text')).rejects.toMatchObject({ retryable: true })

    mocks.downloadDocument.mockResolvedValue(Buffer.from(ENGLISH))
    state.updateError = { message: 'write failed' }
    await expect(run('text')).rejects.toMatchObject({ retryable: true })
  })
})

describe('normalizeStage: digital text paths', () => {
  it('reads a clinical note directly with confidence 1 and advances', async () => {
    mocks.downloadDocument.mockResolvedValue(Buffer.from(ENGLISH))
    expect(await run('text')).toEqual({ kind: 'advance' })
    expect(savedDocument()).toMatchObject({ ocr_engine: 'text', ocr_confidence: 1, page_count: 1 })
    expect(mocks.getOcrClient).not.toHaveBeenCalled()
    expect(mocks.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ocr.completed', payload: { engine: 'text', pages: 1, confidence: 1 } }),
    )
  })

  it('flattens an HL7v2 message with the parser and skips language detection', async () => {
    mocks.downloadDocument.mockResolvedValue(Buffer.from('MSH|^~\\&|LAB|CITY|EHR|CITY|202610071200||ORU^R01|1|P|2.5.1\rOBX|1|NM|2345-7^Glucose^LN||182|mg/dL'))
    expect(await run('hl7v2')).toEqual({ kind: 'advance' })
    const saved = savedDocument()
    expect(saved).toMatchObject({ ocr_engine: 'hl7-parser', ocr_confidence: 1 })
    expect(JSON.stringify(saved?.normalized_text)).toContain('OBX-5: 182')
  })

  it('reads a PDF with a text layer without calling OCR', async () => {
    mocks.downloadDocument.mockResolvedValue(await textPdf(ENGLISH.match(/.{1,90}(\s|$)/g) ?? [ENGLISH]))
    expect(await run('pdf')).toEqual({ kind: 'advance' })
    expect(savedDocument()).toMatchObject({ ocr_engine: 'pdf-text', ocr_confidence: 0.99 })
    expect(mocks.getOcrClient).not.toHaveBeenCalled()
  })
})

describe('normalizeStage: scans', () => {
  it('holds a scanned PDF for review as ocr_unavailable when no OCR engine is configured', async () => {
    mocks.downloadDocument.mockResolvedValue(await blankPdf())
    expect(await run('pdf')).toEqual({ kind: 'escalate', reason: 'ocr_unavailable' })
    expect(mocks.updates).not.toHaveBeenCalled()
    expect(mocks.appendAudit).not.toHaveBeenCalled()
  })

  it('holds an image the same way', async () => {
    mocks.downloadDocument.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    state.document = { data: { storage_path: 'p', mime_type: 'image/jpeg', page_count: null }, error: null }
    expect(await run('image')).toEqual({ kind: 'escalate', reason: 'ocr_unavailable' })
  })

  it('sends the original to the configured engine, storing its result and confidence', async () => {
    const recognize = vi.fn().mockResolvedValue(ocrResult(0.93))
    mocks.getOcrClient.mockReturnValue({ recognize } satisfies OcrClient)
    const scan = await blankPdf()
    mocks.downloadDocument.mockResolvedValue(scan)

    expect(await run('pdf')).toEqual({ kind: 'advance' })
    expect(recognize).toHaveBeenCalledWith({ bytes: scan, mimeType: 'application/pdf', pageCount: 1 })
    expect(savedDocument()).toMatchObject({ ocr_engine: 'fake-ocr', ocr_confidence: 0.93 })
  })

  it('propagates an engine failure so the worker can retry or escalate it', async () => {
    mocks.getOcrClient.mockReturnValue({ recognize: vi.fn().mockRejectedValue(new AppError('UPSTREAM_ERROR', 'engine down')) })
    mocks.downloadDocument.mockResolvedValue(await blankPdf())
    await expect(run('pdf')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true })
  })

  it('propagates a non-retryable error when the selected OCR adapter is not shipped', async () => {
    mocks.getOcrClient.mockImplementation(() => {
      throw new AppError('INTERNAL', 'The textract OCR adapter is not available in this release.', { retryable: false })
    })
    mocks.downloadDocument.mockResolvedValue(await blankPdf())
    await expect(run('pdf')).rejects.toMatchObject({ retryable: false })
  })
})

describe('normalizeStage: quality floor', () => {
  const withEngine = (result: OcrResult) => {
    mocks.getOcrClient.mockReturnValue({ recognize: vi.fn().mockResolvedValue(result) })
  }

  it('rejects below the floor, keeps the text for the reviewer, audits it and prioritises the task', async () => {
    withEngine(ocrResult(0.78))
    mocks.downloadDocument.mockResolvedValue(await blankPdf())

    expect(await run('pdf')).toEqual({ kind: 'escalate', reason: 'low_ocr_quality', priority: 75 })
    expect(savedDocument()).toMatchObject({ ocr_engine: 'fake-ocr', ocr_confidence: 0.78 })
    expect(mocks.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ocr.rejected_low_quality', payload: expect.objectContaining({ confidence: 0.78, floor: 0.8 }) }),
    )
    expect(mocks.appendAudit).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'ocr.completed' }))
  })

  it('accepts exactly at the floor', async () => {
    withEngine(ocrResult(0.8))
    mocks.downloadDocument.mockResolvedValue(await blankPdf())
    expect(await run('pdf')).toEqual({ kind: 'advance' })
  })

  it('escalates handwriting-heavy scans with their own reason', async () => {
    withEngine(ocrResult(0.95, { handwrittenRatio: 0.5 }))
    mocks.downloadDocument.mockResolvedValue(await blankPdf())
    expect(await run('pdf')).toEqual({ kind: 'escalate', reason: 'handwriting', priority: 75 })
  })

  it('escalates non-English documents before extraction', async () => {
    const hindi = 'मरीज को बुखार और खांसी की शिकायत के साथ अस्पताल में भर्ती किया गया था। जांच में दाहिने फेफड़े में संक्रमण पाया गया। उन्हें एंटीबायोटिक दवाइयां दी गईं और स्वस्थ होने पर छुट्टी दे दी गई।'
    mocks.downloadDocument.mockResolvedValue(Buffer.from(hindi))
    expect(await run('text')).toEqual({ kind: 'escalate', reason: 'language_unsupported' })
    expect(mocks.appendAudit).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'ocr.completed' }))
  })

  it('escalates an unreadable PDF as unreadable_document (a new file is needed, not a retry)', async () => {
    mocks.downloadDocument.mockResolvedValue(Buffer.from('%PDF-1.7 broken'))
    expect(await run('pdf')).toEqual({ kind: 'escalate', reason: 'unreadable_document' })
    expect(mocks.getOcrClient).not.toHaveBeenCalled()
  })
})

describe('normalizeStage: audit hygiene', () => {
  it('never puts document text into audit payloads', async () => {
    mocks.downloadDocument.mockResolvedValue(Buffer.from(ENGLISH))
    await run('text')
    expect(JSON.stringify(mocks.appendAudit.mock.calls)).not.toContain('crepitations')
  })
})
