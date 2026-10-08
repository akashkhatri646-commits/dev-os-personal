import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getRuntimeConfig } from '@/server/config/constants'
import type { StageContext, StageOutcome } from '@/server/pipeline/stages'
import { appendAudit } from '@/server/services/audit/auditLog'
import { assertConsentValid } from '@/server/services/consent/ConsentService'
import { parseHl7 } from '@/server/services/hl7/parser'
import { checkLanguage } from '@/server/services/normalization/language'
import { extractPdfText } from '@/server/services/normalization/pdfText'
import { assessQuality, weightedConfidence } from '@/server/services/normalization/quality'
import { textToPages } from '@/server/services/normalization/textDocument'
import { getOcrClient } from '@/server/services/ocr/OcrClient'
import { downloadDocument } from '@/server/services/storage/documentStorage'
import { DIGITAL_TEXT_CONFIDENCE, type OcrResult } from '@/types/ocr'

/** Queue priority (static part) for scans a person must re-request: shown ahead of ordinary escalations. */
const LOW_QUALITY_PRIORITY = 75

interface StoredDocument {
  storage_path: string
  mime_type: string
  page_count: number | null
}

async function loadDocument(recordId: string): Promise<StoredDocument | null> {
  const { data, error } = await getSupabaseAdmin()
    .from('documents')
    .select('storage_path, mime_type, page_count')
    .eq('record_id', recordId)
    .limit(1)
    .maybeSingle()
  if (error) throw new AppError('INTERNAL', 'Failed to load the document.', { cause: error, retryable: true })
  return data as StoredDocument | null
}

/**
 * Component 1: normalisation. Produces citeable text pages (blocks with ids and, for PDFs, bounding
 * boxes) from whatever was submitted.
 *
 * - HL7v2 and text notes are read directly; PDFs with a text layer are read directly.
 * - Scans (image files and PDFs without a text layer) go to the configured OCR engine. With none
 *   configured the record is held for review (`ocr_unavailable`) and can be retried once one is.
 * - Every result meets the same quality floor: below the OCR confidence floor, a very poor page, or
 *   too much handwriting sends the record to review before anything is extracted.
 * - Only English is supported for now.
 *
 * Runs only after a valid consent check (re-asserted here), so no content is read ahead of consent.
 */
export async function normalizeStage({ record }: StageContext): Promise<StageOutcome> {
  await assertConsentValid(record.id)

  const document = await loadDocument(record.id)
  if (!document) return { kind: 'fail', reason: 'document_missing' }

  const bytes = await downloadDocument(document.storage_path)
  let result: OcrResult
  let pageCount = document.page_count

  try {
    if (record.input_kind === 'hl7v2') {
      const parsed = parseHl7(bytes.toString('utf8'))
      result = {
        engine: 'hl7-parser',
        pages: parsed.pages.map((page) => ({ ...page, confidence: DIGITAL_TEXT_CONFIDENCE.hl7 })),
      }
    } else if (record.input_kind === 'text') {
      result = { engine: 'text', pages: textToPages(bytes.toString('utf8')) }
    } else {
      let scanned: OcrResult | null = null
      if (record.input_kind === 'pdf') {
        const pdf = await extractPdfText(bytes)
        pageCount = pdf.pageCount
        if (pdf.pages) scanned = { engine: 'pdf-text', pages: pdf.pages }
      }
      if (!scanned) {
        const client = getOcrClient()
        if (!client) return { kind: 'escalate', reason: 'ocr_unavailable' }
        scanned = await client.recognize({ bytes, mimeType: document.mime_type, pageCount })
      }
      result = scanned
    }
  } catch (error) {
    if (error instanceof AppError && error.reason === 'unreadable_document') {
      return { kind: 'escalate', reason: 'unreadable_document' }
    }
    throw error
  }

  const { ocrConfidenceFloor } = getRuntimeConfig()
  const quality = assessQuality(result.pages, ocrConfidenceFloor)

  // Keep what was recognised even when it is rejected, so the reviewer can see why.
  const { error: saveError } = await getSupabaseAdmin()
    .from('documents')
    .update({
      normalized_text: result.pages,
      page_count: pageCount ?? result.pages.length,
      ocr_engine: result.engine,
      ocr_confidence: quality.confidence || weightedConfidence(result.pages),
    })
    .eq('record_id', record.id)
  if (saveError) {
    throw new AppError('INTERNAL', 'Failed to save the recognised text.', { cause: saveError, retryable: true })
  }

  if (!quality.ok) {
    await appendAudit({
      orgId: record.org_id,
      recordId: record.id,
      actor: { type: 'system' },
      event: 'ocr.rejected_low_quality',
      payload: { engine: result.engine, reason: quality.reason, confidence: quality.confidence, floor: ocrConfidenceFloor },
    })
    return { kind: 'escalate', reason: quality.reason === 'handwriting' ? 'handwriting' : 'low_ocr_quality', priority: LOW_QUALITY_PRIORITY }
  }

  // HL7 messages are codes and short fields: language detection only means something for prose.
  if (record.input_kind !== 'hl7v2') {
    const language = await checkLanguage(result.pages.map((page) => page.text).join('\n'))
    if (!language.supported) return { kind: 'escalate', reason: 'language_unsupported' }
  }

  await appendAudit({
    orgId: record.org_id,
    recordId: record.id,
    actor: { type: 'system' },
    event: 'ocr.completed',
    payload: {
      engine: result.engine,
      pages: result.pages.length,
      confidence: quality.confidence,
    },
  })
  return { kind: 'advance' }
}
