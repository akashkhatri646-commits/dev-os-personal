import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import {
  assertTransition,
  isTerminal,
  type JobStage,
} from '@/server/pipeline/transitions'
import { appendAudit } from '@/server/services/audit/auditLog'
import { createReviewTask, type ReviewKind } from '@/server/services/review/tasks'
import { RECORD_STATUSES, type RecordStatus } from '@/types/domain'

export const recordRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  source_id: z.string(),
  patient_id: z.string().nullable(),
  doc_type: z.enum(['discharge_summary', 'lab_report', 'other']),
  input_kind: z.enum(['pdf', 'image', 'hl7v2', 'text']),
  data_categories: z.array(z.string()),
  status: z.enum(RECORD_STATUSES),
  status_reason: z.string().nullable(),
  created_at: z.string(),
})
export type RecordRow = z.infer<typeof recordRowSchema>

export const RECORD_COLUMNS =
  'id, org_id, source_id, patient_id, doc_type, input_kind, data_categories, status, status_reason, created_at'

export async function loadRecord(recordId: string): Promise<RecordRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from('ingestion_records')
    .select(RECORD_COLUMNS)
    .eq('id', recordId)
    .maybeSingle()
  if (error) throw new AppError('INTERNAL', 'Failed to load the record.', { cause: error, retryable: true })
  return data ? recordRowSchema.parse(data) : null
}

export interface SetStatusOptions {
  /** Machine-readable reason stored on the record and in the audit event (never free text). */
  reason?: string | null
  /** Allows leaving `failed`/`needs_review` to re-run a stage. */
  retry?: boolean
}

/**
 * Moves a record to a new status, validating the transition and using the previous status as an
 * optimistic lock so two workers cannot both apply a transition. Writes an audit event.
 */
export async function setStatus(record: RecordRow, to: RecordStatus, options: SetStatusOptions = {}): Promise<RecordRow> {
  if (record.status === to && (options.reason ?? null) === record.status_reason) return record
  assertTransition(record.status, to, { retry: options.retry })

  const reason = options.reason ?? null
  const { data, error } = await getSupabaseAdmin()
    .from('ingestion_records')
    .update({
      status: to,
      status_reason: reason,
      ...(isTerminal(to) ? { completed_at: new Date().toISOString() } : {}),
    })
    .eq('id', record.id)
    .eq('status', record.status)
    .select(RECORD_COLUMNS)
    .maybeSingle()
  if (error) throw new AppError('INTERNAL', 'Failed to update the record status.', { cause: error, retryable: true })
  if (!data) {
    throw new AppError('CONFLICT', 'The record changed while it was being processed.', {
      reason: 'STATUS_CHANGED',
      retryable: true,
    })
  }

  await appendAudit({
    orgId: record.org_id,
    recordId: record.id,
    actor: { type: 'system' },
    event: 'record.status_changed',
    payload: { from: record.status, to, ...(reason ? { reason } : {}) },
  })
  return recordRowSchema.parse(data)
}

/**
 * Sends a record to human review: status `needs_review` plus an open review task. A reason is
 * always recorded so the reviewer and the audit trail show why automation stopped.
 */
export async function escalateRecord(
  record: RecordRow,
  reason: string,
  priority = 0,
  kind: ReviewKind = 'escalation',
): Promise<RecordRow> {
  if (isTerminal(record.status) || record.status === 'needs_review') return record
  const updated = await setStatus(record, 'needs_review', { reason })
  await createReviewTask(record.id, kind, priority)
  return updated
}

/** Records an unrecoverable failure (status `failed`). Used when the data itself cannot be processed. */
export async function failRecord(record: RecordRow, reason: string): Promise<RecordRow> {
  if (isTerminal(record.status)) return record
  return setStatus(record, 'failed', { reason })
}

export async function auditJobFailure(
  record: RecordRow,
  stage: JobStage,
  attempts: number,
  reason: string,
): Promise<void> {
  await appendAudit({
    orgId: record.org_id,
    recordId: record.id,
    actor: { type: 'system' },
    event: 'worker.job_failed',
    payload: { stage, attempts, reason },
  })
}
