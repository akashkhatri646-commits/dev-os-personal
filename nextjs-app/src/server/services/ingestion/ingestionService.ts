import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { buildPage, cursorFilter, decodeCursor } from '@/lib/api/pagination'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import type { ListRecordsQuery, RetryBody, SubmitIngestionMeta } from '@/lib/validation/ingestion'
import { getRuntimeConfig } from '@/server/config/constants'
import { getEnv } from '@/server/config/env'
import { loadRecord, recordRowSchema, setStatus } from '@/server/pipeline/orchestrator'
import {
  RETRYABLE_STATUSES,
  STAGE_STATUS,
  stageFromReason,
  type JobStage,
} from '@/server/pipeline/transitions'
import { enqueueJob } from '@/server/queue/jobs'
import { appendAudit, appendAuditBestEffort } from '@/server/services/audit/auditLog'
import { detectFileKind, detectTextKind, type DetectedInput } from '@/server/services/ingestion/detectInput'
import { sanitizeFilename } from '@/server/services/ingestion/filename'
import type { ParsedSubmission } from '@/server/services/ingestion/parseSubmission'
import { parseHl7, splitHl7Messages } from '@/server/services/hl7/parser'
import { upsertPatient } from '@/server/services/patients/patientService'
import {
  createSignedDocumentUrl,
  documentPath,
  removeDocument,
  uploadDocument,
} from '@/server/services/storage/documentStorage'
import { triggerWorkerTick } from '@/server/worker/trigger'
import type { AuthUser, RecordStatus } from '@/types/domain'
import type { RecordDetail, RecordEvent, RecordSummary, SubmissionResult } from '@/types/records'

const UNIQUE_VIOLATION = '23505'
const MAX_MANUAL_RETRIES = 3

/** Who is submitting: a signed-in user, or a feed integration identified by its source key. */
export type IngestionPrincipal =
  | { kind: 'user'; user: AuthUser }
  | { kind: 'source_key'; orgId: string; sourceId: string; keyId: string }

function principalOrg(principal: IngestionPrincipal): string {
  return principal.kind === 'user' ? principal.user.orgId : principal.orgId
}

function principalActor(principal: IngestionPrincipal) {
  return principal.kind === 'user'
    ? ({ type: 'user', id: principal.user.userId } as const)
    : ({ type: 'api_key', id: principal.keyId } as const)
}

interface PreparedMessage {
  bytes: Buffer
  detected: DetectedInput
  filename: string
  pageCount: number | null
}

async function pdfPageCount(bytes: Buffer): Promise<number | null> {
  try {
    const document = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
    return document.getPageCount()
  } catch {
    // Unreadable PDFs are not rejected here; the normalisation stage reports `unreadable_document`.
    return null
  }
}

/** Turns the submission into one prepared message per record (an HL7v2 batch yields several). */
async function prepareMessages(parsed: ParsedSubmission, maxPages: number): Promise<PreparedMessage[]> {
  const { content } = parsed

  if (content.kind === 'file') {
    const detected = detectFileKind(content.bytes)
    if (detected.kind === 'pdf') {
      const pageCount = await pdfPageCount(content.bytes)
      if (pageCount !== null && pageCount > maxPages) {
        throw new AppError('VALIDATION_FAILED', `The PDF has ${pageCount} pages; the limit is ${maxPages}.`, {
          reason: 'TOO_MANY_PAGES',
        })
      }
      return [{ bytes: content.bytes, detected, filename: sanitizeFilename(content.filename), pageCount }]
    }
    if (detected.kind === 'image') {
      return [{ bytes: content.bytes, detected, filename: sanitizeFilename(content.filename), pageCount: null }]
    }
    return prepareTextMessages(content.bytes.toString('utf8'), detected, sanitizeFilename(content.filename))
  }

  return prepareTextMessages(content.text, detectTextKind(content.text), 'input.txt')
}

function prepareTextMessages(text: string, detected: DetectedInput, filename: string): PreparedMessage[] {
  if (detected.kind !== 'hl7v2') {
    return [{ bytes: Buffer.from(text, 'utf8'), detected, filename, pageCount: 1 }]
  }
  const messages = splitHl7Messages(text)
  return messages.map((message, index) => {
    parseHl7(message) // rejects payloads that cannot be tokenised before anything is stored
    return {
      bytes: Buffer.from(message, 'utf8'),
      detected,
      filename: messages.length > 1 ? `message-${index + 1}.hl7` : 'message.hl7',
      pageCount: 1,
    }
  })
}

interface ExistingRecord {
  id: string
  status: RecordStatus
  patient_id: string | null
}

async function findDuplicate(
  sourceId: string,
  sha256: string,
  idempotencyKey: string | null,
): Promise<ExistingRecord | null> {
  const admin = getSupabaseAdmin()
  const columns = 'id, status, patient_id'

  if (idempotencyKey) {
    const { data, error } = await admin
      .from('ingestion_records')
      .select(columns)
      .eq('source_id', sourceId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle()
    if (error) throw new AppError('INTERNAL', 'Failed to check for duplicates.', { cause: error })
    if (data) return data as ExistingRecord
  }

  // A record blocked for missing consent does not prevent resubmitting the same document.
  const { data, error } = await admin
    .from('ingestion_records')
    .select(columns)
    .eq('source_id', sourceId)
    .eq('content_sha256', sha256)
    .neq('status', 'blocked_consent')
    .maybeSingle()
  if (error) throw new AppError('INTERNAL', 'Failed to check for duplicates.', { cause: error })
  return (data as ExistingRecord | null) ?? null
}

async function ingestMessage(params: {
  principal: IngestionPrincipal
  meta: SubmitIngestionMeta
  patientId: string
  message: PreparedMessage
  idempotencyKey: string | null
}): Promise<{ record_id: string; status: RecordStatus; duplicate: boolean }> {
  const { principal, meta, patientId, message, idempotencyKey } = params
  const orgId = principalOrg(principal)
  const admin = getSupabaseAdmin()
  const sha256 = createHash('sha256').update(message.bytes).digest('hex')

  const duplicate = async () => {
    const existing = await findDuplicate(meta.source_id, sha256, idempotencyKey)
    if (!existing) return null
    // The same content for a different patient would let a document dodge another patient's consent.
    if (existing.patient_id !== patientId) {
      throw new AppError('CONFLICT', 'This document was already submitted for a different patient.', {
        reason: 'CONTENT_PATIENT_MISMATCH',
      })
    }
    await appendAuditBestEffort({
      orgId,
      recordId: existing.id,
      actor: principalActor(principal),
      event: 'ingest.duplicate',
      payload: { source_id: meta.source_id },
    })
    return { record_id: existing.id, status: existing.status, duplicate: true }
  }

  const known = await duplicate()
  if (known) return known

  const recordId = randomUUID()
  const path = documentPath(orgId, recordId, message.filename)
  await uploadDocument(path, message.bytes, message.detected.mimeType)

  try {
    const { error: recordError } = await admin.from('ingestion_records').insert({
      id: recordId,
      org_id: orgId,
      source_id: meta.source_id,
      patient_id: patientId,
      doc_type: meta.doc_type,
      input_kind: message.detected.kind,
      data_categories: meta.data_categories,
      status: 'received',
      content_sha256: sha256,
      idempotency_key: idempotencyKey,
      submitted_by: principal.kind === 'user' ? principal.user.userId : null,
    })
    if (recordError) {
      if (recordError.code === UNIQUE_VIOLATION) {
        // A concurrent identical submission won the race: return it instead of failing.
        await removeDocument(path).catch(() => undefined)
        const raced = await duplicate()
        if (raced) return raced
      }
      throw new AppError('INTERNAL', 'Failed to create the record.', { cause: recordError })
    }

    const { error: documentError } = await admin.from('documents').insert({
      record_id: recordId,
      storage_path: path,
      mime_type: message.detected.mimeType,
      bytes: message.bytes.length,
      page_count: message.pageCount,
    })
    if (documentError) throw new AppError('INTERNAL', 'Failed to save the document.', { cause: documentError })

    await appendAudit({
      orgId,
      recordId,
      actor: principalActor(principal),
      event: 'ingest.received',
      payload: {
        source_id: meta.source_id,
        doc_type: meta.doc_type,
        input_kind: message.detected.kind,
        bytes: message.bytes.length,
      },
    })
    await enqueueJob(recordId, 'consent_check')
  } catch (error) {
    // Undo a half-finished intake: the record cascades its document and job rows.
    await admin.from('ingestion_records').delete().eq('id', recordId)
    await removeDocument(path).catch(() => undefined)
    throw error
  }

  return { record_id: recordId, status: 'received', duplicate: false }
}

/**
 * Accepts a submission: validates the source and patient, stores the original in the private
 * bucket, creates the record and queues the consent check. Nothing is OCRed or sent to a model here.
 * An HL7v2 batch creates one record per message.
 */
export async function submitIngestion(
  principal: IngestionPrincipal,
  parsed: ParsedSubmission,
  idempotencyKey: string | null,
): Promise<SubmissionResult> {
  const { meta } = parsed
  const orgId = principalOrg(principal)
  if (principal.kind === 'source_key' && principal.sourceId !== meta.source_id) {
    throw new AppError('FORBIDDEN', 'This source key cannot submit for that source.')
  }

  const { data: source, error } = await getSupabaseAdmin()
    .from('provider_sources')
    .select('id, doc_types')
    .eq('id', meta.source_id)
    .eq('org_id', orgId)
    .maybeSingle()
  if (error) throw new AppError('INTERNAL', 'Failed to load the source.', { cause: error })
  if (!source) throw new AppError('NOT_FOUND', 'Source not found.')

  const config = getRuntimeConfig()
  const sourceDocTypes = z.array(z.string()).parse(source.doc_types)
  if (!config.enabledDocTypes.includes(meta.doc_type) || !sourceDocTypes.includes(meta.doc_type)) {
    throw new AppError('VALIDATION_FAILED', 'This document type is not enabled for the source.', {
      reason: 'DOC_TYPE_NOT_ENABLED',
    })
  }

  const messages = await prepareMessages(parsed, getEnv().OCR_MAX_PAGES)
  const patientId = await upsertPatient(orgId, meta.source_id, meta.patient_identifier)

  const results: SubmissionResult['record_ids'] = []
  let first: { record_id: string; status: RecordStatus; duplicate: boolean } | null = null
  let anyNew = false
  for (const [index, message] of messages.entries()) {
    const key = idempotencyKey && messages.length > 1 ? `${idempotencyKey}:${index}` : idempotencyKey
    const result = await ingestMessage({ principal, meta, patientId, message, idempotencyKey: key })
    results.push(result.record_id)
    first ??= result
    if (!result.duplicate) anyNew = true
  }

  if (anyNew) await triggerWorkerTick()
  if (!first) throw new AppError('VALIDATION_FAILED', 'No messages were found in the submission.')
  return { record_id: first.record_id, status: first.status, duplicate: !anyNew, record_ids: results }
}

const summaryRowSchema = recordRowSchema
  .pick({ id: true, source_id: true, doc_type: true, input_kind: true, status: true, status_reason: true, created_at: true })
  .extend({
    completed_at: z.string().nullable(),
    provider_sources: z.union([z.object({ name: z.string() }), z.array(z.object({ name: z.string() }))]).nullable(),
  })

function toSummary(row: z.infer<typeof summaryRowSchema>): RecordSummary {
  const source = Array.isArray(row.provider_sources) ? row.provider_sources[0] : row.provider_sources
  return {
    id: row.id,
    source_id: row.source_id,
    source_name: source?.name ?? null,
    doc_type: row.doc_type,
    input_kind: row.input_kind,
    status: row.status,
    status_reason: row.status_reason,
    created_at: row.created_at,
    completed_at: row.completed_at,
  }
}

const SUMMARY_COLUMNS =
  'id, source_id, doc_type, input_kind, status, status_reason, created_at, completed_at, provider_sources(name)'

export async function listRecords(
  actor: AuthUser,
  query: ListRecordsQuery,
): Promise<{ records: RecordSummary[]; nextCursor: string | null }> {
  let builder = createSupabaseServerClient(actor.accessToken)
    .from('ingestion_records')
    .select(SUMMARY_COLUMNS)
    .eq('org_id', actor.orgId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(query.limit + 1)

  if (query.status && query.status.length > 0) builder = builder.in('status', query.status)
  if (query.source_id) builder = builder.eq('source_id', query.source_id)
  if (query.record_id) builder = builder.eq('id', query.record_id)
  if (query.from) builder = builder.gte('created_at', query.from)
  if (query.to) builder = builder.lte('created_at', query.to)
  if (query.cursor) builder = builder.or(cursorFilter(decodeCursor(query.cursor)))

  const { data, error } = await builder
  if (error) throw new AppError('INTERNAL', 'Failed to load records.', { cause: error })

  const rows = z.array(summaryRowSchema).parse(data ?? [])
  const { items, nextCursor } = buildPage(rows, query.limit)
  return { records: items.map(toSummary), nextCursor }
}

/** Loads a record the actor's organisation owns through RLS; 404 otherwise. */
async function loadOwnedRecord(actor: AuthUser, id: string) {
  const { data, error } = await createSupabaseServerClient(actor.accessToken)
    .from('ingestion_records')
    .select(`${SUMMARY_COLUMNS}, data_categories, cost_usd, latency_ms`)
    .eq('id', id)
    .eq('org_id', actor.orgId)
    .maybeSingle()
  if (error) throw new AppError('INTERNAL', 'Failed to load the record.', { cause: error })
  if (!data) throw new AppError('NOT_FOUND', 'Record not found.')
  return data
}

const detailExtraSchema = z.object({
  data_categories: z.array(z.string()),
  cost_usd: z.coerce.number(),
  latency_ms: z.number().nullable(),
})

export async function getRecordDetail(actor: AuthUser, id: string): Promise<RecordDetail> {
  const raw = await loadOwnedRecord(actor, id)
  const summary = toSummary(summaryRowSchema.parse(raw))
  const extra = detailExtraSchema.parse(raw)

  const supabase = createSupabaseServerClient(actor.accessToken)
  const [documentResult, consentResult, eventsResult] = await Promise.all([
    supabase
      .from('documents')
      .select('mime_type, bytes, page_count, ocr_confidence, ocr_engine')
      .eq('record_id', id)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('consent_checks')
      .select('result, regime, required_categories, matched_scope, checked_at')
      .eq('record_id', id)
      .maybeSingle(),
    // Audit rows are admin-only under RLS; the record was already authorised above.
    getSupabaseAdmin()
      .from('audit_log')
      .select('event, created_at, payload')
      .eq('record_id', id)
      .order('id', { ascending: true })
      .limit(200),
  ])

  const document = documentResult.data
    ? z
        .object({
          mime_type: z.string(),
          bytes: z.number(),
          page_count: z.number().nullable(),
          ocr_confidence: z.coerce.number().nullable(),
          ocr_engine: z.string().nullable(),
        })
        .parse(documentResult.data)
    : null
  const consent = consentResult.data
    ? z
        .object({
          result: z.string(),
          regime: z.string(),
          required_categories: z.array(z.string()),
          matched_scope: z.array(z.string()),
          checked_at: z.string(),
        })
        .parse(consentResult.data)
    : null
  const events: RecordEvent[] = z
    .array(z.object({ event: z.string(), created_at: z.string(), payload: z.record(z.string(), z.unknown()) }))
    .parse(eventsResult.data ?? [])

  return { ...summary, ...extra, document, consent, events }
}

/**
 * Short-lived signed URL for viewing the original. Blocked-consent records cannot be opened: their
 * content must not be viewed. Every access is audited.
 */
export async function getDocumentAccess(
  actor: AuthUser,
  id: string,
): Promise<{ url: string; expires_in: number; mime_type: string; pages: number | null }> {
  const raw = await loadOwnedRecord(actor, id)
  if (summaryRowSchema.parse(raw).status === 'blocked_consent') {
    throw new AppError('FORBIDDEN', 'The document of a consent-blocked record cannot be opened.', {
      reason: 'CONSENT_BLOCKED',
    })
  }

  const { data, error } = await createSupabaseServerClient(actor.accessToken)
    .from('documents')
    .select('storage_path, mime_type, page_count')
    .eq('record_id', id)
    .limit(1)
    .maybeSingle()
  if (error) throw new AppError('INTERNAL', 'Failed to load the document.', { cause: error })
  if (!data) throw new AppError('NOT_FOUND', 'This record has no stored document.')

  const ttl = getRuntimeConfig().signedUrlTtlSeconds
  const url = await createSignedDocumentUrl(data.storage_path as string, ttl)
  await appendAuditBestEffort({
    orgId: actor.orgId,
    recordId: id,
    actor: { type: 'user', id: actor.userId },
    event: 'document.accessed',
    payload: {},
  })
  return {
    url,
    expires_in: ttl,
    mime_type: data.mime_type as string,
    pages: (data.page_count as number | null) ?? null,
  }
}

const STAGE_ORDER: JobStage[] = ['consent_check', 'normalize', 'extract', 'map', 'validate', 'score', 'route']

/** The stage to resume: the latest dead job, else the stage named in the status reason. */
async function stageToRetry(recordId: string, reason: string | null): Promise<JobStage | null> {
  const { data } = await getSupabaseAdmin()
    .from('pipeline_jobs')
    .select('stage')
    .eq('record_id', recordId)
    .eq('status', 'dead')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const dead = data?.stage as JobStage | undefined
  if (dead && dead !== 'commit') return dead
  if (dead === 'commit') return 'route'
  if (reason === 'low_ocr_quality' || reason === 'ocr_unavailable') return 'normalize'
  if (reason === 'llm_unavailable') return 'extract'
  if (reason === 'mapping_unavailable') return 'map'
  return stageFromReason(reason)
}

/**
 * Re-runs a failed or escalated record from the stage that failed (or an earlier one). Limited to
 * 3 manual retries per record; blocked-consent and finished records can never be retried.
 */
export async function retryRecord(actor: AuthUser, id: string, body: RetryBody): Promise<RecordSummary> {
  const raw = await loadOwnedRecord(actor, id)
  const summary = toSummary(summaryRowSchema.parse(raw))

  if (!RETRYABLE_STATUSES.includes(summary.status)) {
    throw new AppError('CONFLICT', 'Only failed or escalated records can be retried.', { reason: 'NOT_RETRYABLE' })
  }
  const reason = summary.status_reason
  const retryableReason =
    summary.status === 'failed' ||
    reason === 'llm_error' ||
    reason === 'low_ocr_quality' ||
    reason === 'ocr_unavailable' ||
    reason === 'llm_unavailable' ||
    reason === 'mapping_unavailable' ||
    reason?.startsWith('stage_error:') === true
  if (!retryableReason) {
    throw new AppError('CONFLICT', 'This record needs a human review, not a retry.', { reason: 'NOT_RETRYABLE' })
  }

  const admin = getSupabaseAdmin()
  const { count: retries, error: countError } = await admin
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('record_id', id)
    .eq('event', 'record.status_changed')
    .contains('payload', { reason: 'manual_retry' })
  if (countError) throw new AppError('INTERNAL', 'Failed to check the retry history.', { cause: countError })
  if ((retries ?? 0) >= MAX_MANUAL_RETRIES) {
    throw new AppError('CONFLICT', `This record was already retried ${MAX_MANUAL_RETRIES} times.`, { reason: 'RETRY_LIMIT' })
  }

  const failedStage = await stageToRetry(id, reason)
  if (!failedStage) {
    throw new AppError('CONFLICT', 'The stage to retry could not be determined.', { reason: 'NOT_RETRYABLE' })
  }
  const stage = body.from_stage ?? failedStage
  if (STAGE_ORDER.indexOf(stage) > STAGE_ORDER.indexOf(failedStage)) {
    throw new AppError('VALIDATION_FAILED', 'Retry can only restart at or before the failed stage.', {
      reason: 'STAGE_AFTER_FAILURE',
    })
  }

  // An open review task would be stale after a retry; a claimed one means a reviewer is working on it.
  const { data: tasks, error: taskError } = await admin
    .from('review_tasks')
    .select('id, status')
    .eq('record_id', id)
    .in('status', ['open', 'claimed'])
  if (taskError) throw new AppError('INTERNAL', 'Failed to check review tasks.', { cause: taskError })
  if ((tasks ?? []).some((task) => task.status === 'claimed')) {
    throw new AppError('CONFLICT', 'A reviewer is working on this record.', { reason: 'TASK_IN_PROGRESS' })
  }
  if ((tasks ?? []).length > 0) await admin.from('review_tasks').delete().eq('record_id', id).eq('status', 'open')

  const record = await loadRecord(id)
  if (!record) throw new AppError('NOT_FOUND', 'Record not found.')
  await setStatus(record, STAGE_STATUS[stage], { retry: true, reason: 'manual_retry' })
  await enqueueJob(id, stage)
  await triggerWorkerTick()

  const refreshed = await loadOwnedRecord(actor, id)
  return toSummary(summaryRowSchema.parse(refreshed))
}

/**
 * Admin re-run: sends a failed or in-review record back to any stage up to `route`, whatever the reason it stopped
 * (a retry only covers technical failures). Earlier results are replaced by the re-run stage. Refused while a
 * reviewer holds the record or a job for it is still queued or running. Always audited.
 */
export async function rerunRecord(actor: AuthUser, id: string, fromStage: JobStage): Promise<RecordSummary> {
  if (actor.role !== 'admin') throw new AppError('FORBIDDEN', 'Only an admin can re-run a record.')
  const summary = toSummary(summaryRowSchema.parse(await loadOwnedRecord(actor, id)))
  if (!RETRYABLE_STATUSES.includes(summary.status)) {
    throw new AppError('CONFLICT', 'Only failed records or records waiting for review can be re-run.', { reason: 'NOT_RETRYABLE' })
  }
  if (!STAGE_ORDER.includes(fromStage)) throw new AppError('VALIDATION_FAILED', 'Unknown stage.')

  const admin = getSupabaseAdmin()
  const { data: active, error: jobError } = await admin
    .from('pipeline_jobs')
    .select('id')
    .eq('record_id', id)
    .in('status', ['queued', 'running'])
    .limit(1)
  if (jobError) throw new AppError('INTERNAL', 'Failed to check the job queue.', { cause: jobError })
  if ((active ?? []).length > 0) throw new AppError('CONFLICT', 'The record is still being processed.', { reason: 'JOB_ACTIVE' })

  const { data: tasks, error: taskError } = await admin.from('review_tasks').select('id, status').eq('record_id', id).in('status', ['open', 'claimed'])
  if (taskError) throw new AppError('INTERNAL', 'Failed to check review tasks.', { cause: taskError })
  if ((tasks ?? []).some((task) => task.status === 'claimed')) {
    throw new AppError('CONFLICT', 'A reviewer is working on this record.', { reason: 'TASK_IN_PROGRESS' })
  }
  if ((tasks ?? []).length > 0) await admin.from('review_tasks').delete().eq('record_id', id).eq('status', 'open')

  const record = await loadRecord(id)
  if (!record) throw new AppError('NOT_FOUND', 'Record not found.')
  await appendAudit({
    orgId: actor.orgId,
    recordId: id,
    actor: { type: 'user', id: actor.userId },
    event: 'record.rerun_requested',
    payload: { from_stage: fromStage, previous_status: summary.status, previous_reason: summary.status_reason },
  })
  await setStatus(record, STAGE_STATUS[fromStage], { retry: true, reason: 'admin_rerun' })
  await enqueueJob(id, fromStage)
  await triggerWorkerTick()

  return toSummary(summaryRowSchema.parse(await loadOwnedRecord(actor, id)))
}

/** Statuses in which a record is waiting on the worker rather than on a person. */
const WORKER_STATUSES = ['received', 'consent_check', 'normalizing', 'extracting', 'mapping', 'validating', 'scoring', 'routing']
/** A job due for less than this long is still about to be picked up: do not start a second pass for it. */
const KICK_AFTER_SECONDS = 8

/**
 * Starts a worker pass for a record that is waiting for one: a safety net for when the usual hand-over between
 * passes is lost. Only does anything when the record has a queued job that has been due for a few seconds, and never
 * touches the record itself, so it is safe to call repeatedly. Returns whether a pass was started.
 */
export async function kickRecord(actor: AuthUser, id: string): Promise<{ kicked: boolean }> {
  const summary = toSummary(summaryRowSchema.parse(await loadOwnedRecord(actor, id)))
  if (!WORKER_STATUSES.includes(summary.status)) return { kicked: false }

  const dueBefore = new Date(Date.now() - KICK_AFTER_SECONDS * 1000).toISOString()
  const { data, error } = await getSupabaseAdmin()
    .from('pipeline_jobs')
    .select('id')
    .eq('record_id', id)
    .eq('status', 'queued')
    .lte('run_at', dueBefore)
    .limit(1)
  if (error) throw new AppError('INTERNAL', 'Failed to check the job queue.', { cause: error })
  if ((data ?? []).length === 0) return { kicked: false }

  await triggerWorkerTick({ waitMs: 2500 })
  return { kicked: true }
}
