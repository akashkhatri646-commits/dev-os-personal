import { apiFetch } from '@/lib/api/client'
import type { SubmitIngestionFormInput } from '@/lib/validation/ingestion'
import type { RecordDetail, RecordSummary, SubmissionResult } from '@/types/records'
import type { Reconstruction, RecordTrace } from '@/types/trace'

export interface RecordListFilters {
  status?: string[]
  sourceId?: string
}

export async function fetchRecordsPage(cursor: string | undefined, limit = 25, filters: RecordListFilters = {}) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  if (filters.status && filters.status.length > 0) params.set('status', filters.status.join(','))
  if (filters.sourceId) params.set('source_id', filters.sourceId)
  const { data, meta } = await apiFetch<RecordSummary[]>(`/api/ingestions?${params.toString()}`)
  return { records: data, nextCursor: meta?.next_cursor ?? null }
}

interface SubmitOptions {
  meta: SubmitIngestionFormInput
  /** A file to upload, or text/HL7 to submit inline. Exactly one is used. */
  file?: File
  text?: string
}

/** Submits one record as multipart form data. The server decides the document kind from the content. */
export async function submitRecord({ meta, file, text }: SubmitOptions): Promise<SubmissionResult> {
  const form = new FormData()
  form.set('source_id', meta.source_id)
  form.set('patient_identifier_type', meta.patient_identifier.type)
  form.set('patient_identifier_value', meta.patient_identifier.value)
  form.set('doc_type', meta.doc_type)
  for (const category of meta.data_categories ?? []) form.append('data_categories', category)
  if (file) form.set('file', file)
  else form.set('text', text ?? '')
  return (await apiFetch<SubmissionResult>('/api/ingestions', { method: 'POST', body: form })).data
}

export async function retryRecord(id: string): Promise<RecordSummary> {
  return (
    await apiFetch<RecordSummary>(`/api/ingestions/${id}/retry`, { method: 'POST', body: JSON.stringify({}) })
  ).data
}

export async function fetchRecordDetail(id: string): Promise<RecordDetail> {
  return (await apiFetch<RecordDetail>(`/api/ingestions/${id}`)).data
}

export async function fetchRecordTrace(id: string): Promise<RecordTrace> {
  return (await apiFetch<RecordTrace>(`/api/ingestions/${id}/trace`)).data
}

export async function fetchReconstruction(id: string): Promise<Reconstruction> {
  return (await apiFetch<Reconstruction>(`/api/audit/records/${id}`)).data
}

/** A short-lived link to the stored original. Every request is audited. */
export async function fetchDocumentLink(id: string): Promise<{ url: string; expires_in: number; mime_type: string; pages: number | null }> {
  return (await apiFetch<{ url: string; expires_in: number; mime_type: string; pages: number | null }>(`/api/ingestions/${id}/document`)).data
}

/** Admin: sends a failed or in-review record back to a stage, whatever stopped it. */
export async function rerunRecord(id: string, fromStage: string): Promise<RecordSummary> {
  return (await apiFetch<RecordSummary>(`/api/admin/records/${id}/rerun`, { method: 'POST', body: JSON.stringify({ from_stage: fromStage }) })).data
}
