const KNOWN: Record<string, string> = {
  missing: 'No consent on file for this patient',
  expired: 'The patient consent has expired',
  revoked: 'The patient consent was revoked',
  out_of_scope: 'Consent does not cover the requested data categories',
  patient_missing: 'The record has no patient',
  source_missing: 'The source no longer exists',
  low_ocr_quality: 'Low scan quality: request a clearer copy',
  unreadable_document: 'The file could not be read',
  ocr_unavailable: 'Text recognition is not set up yet: retry once it is',
  handwriting: 'Handwriting detected: request a typed copy',
  llm_unavailable: 'The language model is not set up yet: retry once it is',
  mapping_unavailable: 'The language model is not set up yet: retry once it is',
  no_data_extracted: 'Nothing could be extracted from this document',
  document_not_normalized: 'The document text is missing',
  document_missing: 'The stored document is missing',
  language_unsupported: 'Language not supported yet',
  llm_error: 'Automatic processing failed',
  too_many_pages: 'Too many pages',
  consent_service_error: 'Consent service unavailable',
  manual_retry: 'Retry requested',
  admin_rerun: 'Re-run requested by an admin',
  below_threshold: 'Confidence below threshold',
  low_ocr: 'Scan quality below the minimum',
  ambiguous_label: 'A value was ambiguous or unusual',
  schema_invalid: 'Failed FHIR validation',
  source_not_enabled: 'Source is in manual-review mode',
  holdback: 'Selected for audit review',
  ungrounded: 'A value could not be traced to the source',
  uncoded: 'A term could not be coded',
  reupload_requested: 'Re-upload requested',
  reviewer_rejected: 'Rejected by a reviewer',
  source_paused: 'Source auto-commit paused',
}

/** Plain-language label for a machine-readable status reason code. */
export function reasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null
  if (KNOWN[reason]) return KNOWN[reason] ?? null
  const stageError = /^stage_error:(\w+)$/.exec(reason)
  if (stageError?.[1]) return `Processing stopped at the ${stageError[1].replaceAll('_', ' ')} step`
  return reason.replaceAll('_', ' ')
}

/** True when an operator can usefully retry a record in this state (mirrors the server rule). */
export function isRetryable(status: string, reason: string | null | undefined): boolean {
  if (status === 'failed') return true
  if (status !== 'needs_review') return false
  return (
    reason === 'llm_error' ||
    reason === 'low_ocr_quality' ||
    reason === 'ocr_unavailable' ||
    reason === 'llm_unavailable' ||
    reason === 'mapping_unavailable' ||
    reason?.startsWith('stage_error:') === true
  )
}
