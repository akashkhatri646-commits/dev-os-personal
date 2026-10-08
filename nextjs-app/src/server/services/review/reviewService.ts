import 'server-only'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import type { ListReviewTasksQuery, ReuploadBody, SubmitReviewBody, TerminologySearchQuery } from '@/lib/validation/review'
import { getRuntimeConfig } from '@/server/config/constants'
import { loadRecord, setStatus, type RecordRow } from '@/server/pipeline/orchestrator'
import { sendAlert } from '@/server/services/alerts/alerts'
import { appendAudit, appendAuditBestEffort } from '@/server/services/audit/auditLog'
import { commitErrorToAppError } from '@/server/services/commit/commitErrors'
import { runConsentCheck } from '@/server/services/consent/runCheck'
import { catalogFor } from '@/server/services/extraction/fieldCatalog'
import { getFhirValidator } from '@/server/services/fhir/validator'
import type { StoredField } from '@/server/services/mapping/entities'
import { purgeRecordPHI } from '@/server/services/review/purge'
import { applyDecisions, checkDecisions, rebuildResources, type DecisionIssue } from '@/server/services/review/submitPlan'
import {
  buildWorkspaceResources,
  visibleDecision,
  type WorkspaceFieldRow,
  type WorkspaceResourceRow,
  type WorkspaceScoreRow,
} from '@/server/services/review/workspace'
import { loadWorkspaceData, resourcesOf } from '@/server/services/review/recordData'
import { createSignedDocumentUrl } from '@/server/services/storage/documentStorage'
import { getEmbeddingsClient, SupabaseTerminologySearch } from '@/server/services/terminology/search'
import type { AuthUser, CodeSystem, Coding } from '@/types/domain'
import type {
  ReviewKind,
  ReviewSubmitResult,
  ReviewTaskSummary,
  ReviewWorkspace,
  TerminologyHit,
  WorkspaceField,
  WorkspaceResource,
} from '@/types/review'

/** A reviewer may hold at most this many open claims at once. */
export const MAX_CLAIMS_PER_REVIEWER = 3
const MAX_LISTED_TASKS = 500
const REUPLOAD_REASONS = ['low_ocr_quality', 'unreadable_document', 'language_unsupported']

function fail(message: string, cause: unknown): never {
  throw new AppError('INTERNAL', message, { cause })
}

const taskRowSchema = z.object({
  id: z.string(),
  record_id: z.string(),
  status: z.enum(['open', 'claimed', 'completed', 'released']),
  kind: z.enum(['escalation', 'holdback_audit', 'downstream_error_review']),
  priority: z.coerce.number(),
  claimed_by: z.string().nullable(),
  lock_expires_at: z.string().nullable(),
  created_at: z.string(),
})
type TaskRow = z.infer<typeof taskRowSchema>

const TASK_COLUMNS = 'id, record_id, status, kind, priority, claimed_by, lock_expires_at, created_at'

const isAdmin = (actor: AuthUser) => actor.role === 'admin'
const lockLive = (task: Pick<TaskRow, 'lock_expires_at'>) => task.lock_expires_at !== null && Date.parse(task.lock_expires_at) > Date.now()

/** What a reviewer sees as the task kind: an audit sample looks like any other escalation. */
const visibleKind = (kind: ReviewKind, actor: AuthUser): ReviewKind => (kind === 'holdback_audit' && !isAdmin(actor) ? 'escalation' : kind)

async function loadTask(actor: AuthUser, id: string): Promise<{ task: TaskRow; record: RecordRow }> {
  const { data, error } = await getSupabaseAdmin().from('review_tasks').select(TASK_COLUMNS).eq('id', id).maybeSingle()
  if (error) fail('Failed to load the review task.', error)
  if (!data) throw new AppError('NOT_FOUND', 'Review task not found.')
  const task = taskRowSchema.parse(data)
  const record = await loadRecord(task.record_id)
  if (!record || record.org_id !== actor.orgId) throw new AppError('NOT_FOUND', 'Review task not found.')
  return { task, record }
}

function assertOpenForReview(task: TaskRow, record: RecordRow): void {
  if (task.status === 'completed' || (record.status !== 'needs_review' && record.status !== 'in_review')) {
    throw new AppError('GONE', 'This review task is closed.', { reason: 'TASK_CLOSED' })
  }
}

/** The caller must hold a live lock on the task. */
function assertLockOwner(actor: AuthUser, task: TaskRow): void {
  if (task.status !== 'claimed' || task.claimed_by !== actor.userId || !lockLive(task)) {
    throw new AppError('CONFLICT', 'Your hold on this task has expired. Claim it again to continue.', { reason: 'LOCK_LOST' })
  }
}

// ---------- listing ----------

const listRowSchema = taskRowSchema.extend({
  ingestion_records: z.object({
    org_id: z.string(),
    doc_type: z.enum(['discharge_summary', 'lab_report', 'other']),
    status_reason: z.string().nullable(),
    provider_sources: z.object({ name: z.string() }).nullable(),
  }),
})

export async function listTasks(actor: AuthUser, query: ListReviewTasksQuery): Promise<{ tasks: ReviewTaskSummary[]; nextCursor: string | null }> {
  const admin = getSupabaseAdmin()
  let builder = admin
    .from('review_tasks')
    .select(`${TASK_COLUMNS}, ingestion_records!inner(org_id, doc_type, status_reason, provider_sources(name))`)
    .eq('ingestion_records.org_id', actor.orgId)
    .eq('status', query.status)
    .limit(MAX_LISTED_TASKS)
  if (query.kind && isAdmin(actor)) builder = builder.eq('kind', query.kind)
  if (query.source_id) builder = builder.eq('ingestion_records.source_id', query.source_id)
  if (query.mine) builder = builder.eq('claimed_by', actor.userId)
  const { data, error } = await builder
  if (error) fail('Failed to list review tasks.', error)
  const rows = z.array(listRowSchema).parse(data ?? [])
  if (rows.length === 0) return { tasks: [], nextCursor: null }

  const recordIds = rows.map((row) => row.record_id)
  const claimerIds = [...new Set(rows.map((row) => row.claimed_by).filter((value): value is string => value !== null))]
  const [decisions, resources, profiles] = await Promise.all([
    admin.from('routing_decisions').select('record_id, escalation_reasons, aggregate_score').in('record_id', recordIds),
    admin.from('mapped_resources').select('record_id, resource_type').in('record_id', recordIds),
    claimerIds.length > 0 ? admin.from('profiles').select('id, full_name, email').in('id', claimerIds) : Promise.resolve({ data: [], error: null }),
  ])
  if (decisions.error) fail('Failed to load routing decisions.', decisions.error)
  if (resources.error) fail('Failed to load resources.', resources.error)
  if (profiles.error) fail('Failed to load reviewers.', profiles.error)

  const decisionByRecord = new Map((decisions.data ?? []).map((row) => [row.record_id as string, row]))
  const typesByRecord = new Map<string, Set<string>>()
  for (const row of resources.data ?? []) {
    const set = typesByRecord.get(row.record_id as string) ?? new Set<string>()
    set.add(row.resource_type as string)
    typesByRecord.set(row.record_id as string, set)
  }
  const nameById = new Map((profiles.data ?? []).map((row) => [row.id as string, (row.full_name as string | null) ?? (row.email as string)]))

  const now = Date.now()
  const summaries = rows
    .map<ReviewTaskSummary>((row) => {
      const decision = decisionByRecord.get(row.record_id)
      const reasons = ((decision?.escalation_reasons as string[] | undefined) ?? (row.ingestion_records.status_reason ? [row.ingestion_records.status_reason] : []))
        .filter((reason) => isAdmin(actor) || reason !== 'holdback')
      return {
        id: row.id,
        record_id: row.record_id,
        kind: visibleKind(row.kind, actor),
        status: row.status,
        priority: row.priority,
        source_name: row.ingestion_records.provider_sources?.name ?? 'Unknown source',
        doc_type: row.ingestion_records.doc_type,
        reasons,
        min_field_score: decision ? Number(decision.aggregate_score) : null,
        resource_types: [...(typesByRecord.get(row.record_id) ?? [])].sort(),
        age_minutes: Math.max(0, Math.floor((now - Date.parse(row.created_at)) / 60_000)),
        claimed_by_name: row.claimed_by ? (nameById.get(row.claimed_by) ?? null) : null,
        claimed_by_me: row.claimed_by === actor.userId,
        lock_expires_at: row.lock_expires_at,
        created_at: row.created_at,
      }
    })
    .filter((summary) => !query.resource_type || summary.resource_types.includes(query.resource_type))
    // Static priority plus age in hours: older tasks rise (spec 09 §2).
    .sort((a, b) => b.priority + b.age_minutes / 60 - (a.priority + a.age_minutes / 60) || a.created_at.localeCompare(b.created_at))

  const offset = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0
  const page = summaries.slice(offset, offset + query.limit)
  return { tasks: page, nextCursor: offset + query.limit < summaries.length ? String(offset + query.limit) : null }
}

// ---------- claim / heartbeat / release ----------

/**
 * Asks the consent ledger again before a reviewer works on, or commits, a record. When consent is
 * gone the record is blocked, its extracted data is purged and the task is closed.
 */
async function ensureConsentStillValid(record: RecordRow, taskId: string): Promise<void> {
  if (!record.patient_id) throw new AppError('CONFLICT', 'This record has no patient.', { reason: 'PATIENT_MISSING' })
  const checked = await runConsentCheck({ ...record, patient_id: record.patient_id })
  if (checked.missingSource) throw new AppError('CONFLICT', 'The source no longer exists.', { reason: 'SOURCE_MISSING' })
  if (checked.verdict.result === 'error') throw new AppError('UPSTREAM_ERROR', 'The consent service could not be reached. Try again shortly.', { retryable: true })
  if (checked.verdict.result === 'valid') return

  await setStatus(record, 'blocked_consent', { reason: checked.verdict.result })
  const { error } = await getSupabaseAdmin().from('review_tasks').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', taskId)
  if (error) fail('Failed to close the review task.', error)
  await appendAudit({ orgId: record.org_id, recordId: record.id, actor: { type: 'system' }, event: 'consent.blocked', payload: { reason: checked.verdict.result, during: 'review' } })
  await purgeRecordPHI(record.org_id, record.id)
  await sendAlert({ kind: 'consent_blocked', message: `Record ${record.id} was blocked during review: consent ${checked.verdict.result.replaceAll('_', ' ')}.` })
  throw new AppError('CONFLICT', 'The patient consent is no longer valid, so this record was blocked.', { reason: 'CONSENT_NO_LONGER_VALID' })
}

export async function claimTask(actor: AuthUser, id: string): Promise<{ lock_expires_at: string }> {
  const { task, record } = await loadTask(actor, id)
  assertOpenForReview(task, record)
  if (task.status === 'claimed' && lockLive(task)) {
    // Opening your own task again is not a new claim.
    if (task.claimed_by === actor.userId && task.lock_expires_at) return { lock_expires_at: task.lock_expires_at }
    throw new AppError('CONFLICT', 'Another reviewer is working on this task.', { reason: 'ALREADY_CLAIMED' })
  }

  const admin = getSupabaseAdmin()
  const { count, error: countError } = await admin
    .from('review_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('claimed_by', actor.userId)
    .eq('status', 'claimed')
    .gt('lock_expires_at', new Date().toISOString())
  if (countError) fail('Failed to check your open claims.', countError)
  if ((count ?? 0) >= MAX_CLAIMS_PER_REVIEWER) {
    throw new AppError('CONFLICT', `You already hold ${MAX_CLAIMS_PER_REVIEWER} tasks. Finish or release one first.`, { reason: 'CLAIM_LIMIT' })
  }

  await ensureConsentStillValid(record, id)

  const now = new Date()
  const lockExpires = new Date(now.getTime() + getRuntimeConfig().reviewLockMinutes * 60_000).toISOString()
  // Conditional update: of two simultaneous claims, only one finds the task open (or its lock expired).
  const { data: claimed, error } = await admin
    .from('review_tasks')
    .update({ status: 'claimed', claimed_by: actor.userId, claimed_at: now.toISOString(), lock_expires_at: lockExpires })
    .eq('id', id)
    .or(`status.eq.open,and(status.eq.claimed,lock_expires_at.lt.${now.toISOString()})`)
    .select('id')
  if (error) fail('Failed to claim the task.', error)
  if (!claimed || claimed.length === 0) throw new AppError('CONFLICT', 'Another reviewer is working on this task.', { reason: 'ALREADY_CLAIMED' })

  if (record.status === 'needs_review') await setStatus(record, 'in_review')
  await appendAudit({ orgId: actor.orgId, recordId: record.id, actor: { type: 'user', id: actor.userId }, event: 'review.claimed', payload: { task_id: id } })
  return { lock_expires_at: lockExpires }
}

export async function heartbeatTask(actor: AuthUser, id: string): Promise<{ lock_expires_at: string }> {
  const { task, record } = await loadTask(actor, id)
  assertOpenForReview(task, record)
  assertLockOwner(actor, task)
  const lockExpires = new Date(Date.now() + getRuntimeConfig().reviewLockMinutes * 60_000).toISOString()
  const { data, error } = await getSupabaseAdmin()
    .from('review_tasks')
    .update({ lock_expires_at: lockExpires })
    .eq('id', id)
    .eq('claimed_by', actor.userId)
    .eq('status', 'claimed')
    .select('id')
  if (error) fail('Failed to extend the hold.', error)
  if (!data || data.length === 0) throw new AppError('CONFLICT', 'Your hold on this task has expired. Claim it again to continue.', { reason: 'LOCK_LOST' })
  return { lock_expires_at: lockExpires }
}

export async function releaseTask(actor: AuthUser, id: string): Promise<void> {
  const { task, record } = await loadTask(actor, id)
  assertOpenForReview(task, record)
  if (task.status !== 'claimed') return
  if (task.claimed_by !== actor.userId && !isAdmin(actor)) throw new AppError('FORBIDDEN', 'Only the reviewer holding this task, or an admin, can release it.')

  const { error } = await getSupabaseAdmin()
    .from('review_tasks')
    .update({ status: 'open', claimed_by: null, claimed_at: null, lock_expires_at: null })
    .eq('id', id)
    .eq('status', 'claimed')
  if (error) fail('Failed to release the task.', error)
  if (record.status === 'in_review') await setStatus(record, 'needs_review')
  await appendAudit({ orgId: actor.orgId, recordId: record.id, actor: { type: 'user', id: actor.userId }, event: 'review.released', payload: { task_id: id, reason: 'released' } })
}

// ---------- workspace ----------

const pagesSchema = z.array(z.object({ page: z.number(), text: z.string() }))

export async function getWorkspace(actor: AuthUser, id: string): Promise<ReviewWorkspace> {
  const { task, record } = await loadTask(actor, id)
  assertOpenForReview(task, record)
  if (isAdmin(actor)) {
    if (task.status === 'claimed' && task.claimed_by === actor.userId) assertLockOwner(actor, task)
  } else {
    if (task.status !== 'claimed' || task.claimed_by !== actor.userId) {
      throw new AppError('FORBIDDEN', task.status === 'claimed' ? 'Another reviewer holds this task.' : 'Claim this task to open it.', {
        reason: task.status === 'claimed' ? 'CLAIMED_BY_OTHER' : 'CLAIM_REQUIRED',
      })
    }
    assertLockOwner(actor, task)
  }

  const data = await loadWorkspaceData(record)
  const pages = pagesSchema.safeParse(data.document?.normalized_text)
  const signedUrl = data.document?.storage_path ? await createSignedDocumentUrl(data.document.storage_path as string, 300) : null

  await appendAuditBestEffort({ orgId: actor.orgId, recordId: record.id, actor: { type: 'user', id: actor.userId }, event: 'document.accessed', payload: { task_id: id } })

  const shown = data.decision ? visibleDecision({ reasons: data.decision.escalation_reasons, reasoning_trace: data.decision.reasoning_trace }, task.kind, isAdmin(actor)) : null
  return {
    task: {
      id: task.id,
      kind: visibleKind(task.kind, actor),
      lock_expires_at: task.lock_expires_at,
      held_by_me: task.status === 'claimed' && task.claimed_by === actor.userId && lockLive(task),
    },
    record: {
      id: record.id,
      doc_type: record.doc_type,
      status: record.status,
      status_reason: record.status_reason,
      ocr_confidence: data.document?.ocr_confidence === null || data.document?.ocr_confidence === undefined ? null : Number(data.document.ocr_confidence),
      source: { id: record.source_id, name: data.source?.name ?? 'Unknown source' },
    },
    document: { signed_url: signedUrl, mime_type: (data.document?.mime_type as string | undefined) ?? null, pages: pages.success ? pages.data.map(({ page, text }) => ({ page, text })) : [] },
    decision: data.decision && shown
      ? {
          aggregate_score: data.decision.aggregate_score,
          reasons: shown.reasons,
          reasoning_trace: shown.reasoning_trace,
          thresholds_applied: Object.fromEntries(
            Object.entries(data.decision.thresholds_applied).filter(([key]) => key !== '_checksum'),
          ) as NonNullable<ReviewWorkspace['decision']>['thresholds_applied'],
        }
      : null,
    consent: data.consent,
    resources: resourcesOf(record, data),
  }
}

// ---------- submit ----------

function decisionError(issues: readonly DecisionIssue[]): AppError {
  const first = issues[0]
  return new AppError('VALIDATION_FAILED', first?.message ?? 'The decisions are not valid.', {
    reason: issues.some((issue) => issue.reason === 'DECISION_MISSING') ? 'DECISION_MISSING' : (first?.reason ?? 'VALIDATION_FAILED'),
    details: { issues },
  })
}

async function lookUpCodes(codes: readonly { system: CodeSystem; code: string }[]): Promise<Map<string, string>> {
  const displays = new Map<string, string>()
  for (const { system, code } of codes) {
    const { data, error } = await getSupabaseAdmin().from('terminology_concepts').select('display').eq('system', system).eq('code', code).limit(1).maybeSingle()
    if (error) fail('Failed to check the code.', error)
    if (data) displays.set(`${system}|${code}`, data.display as string)
  }
  return displays
}

function mapSubmitError(error: { message: string }): AppError {
  if (error.message.includes('lock_lost')) return new AppError('CONFLICT', 'Your hold on this task has expired. Claim it again to continue.', { reason: 'LOCK_LOST' })
  if (error.message.includes('task_closed')) return new AppError('GONE', 'This review task is closed.', { reason: 'TASK_CLOSED' })
  return commitErrorToAppError(error)
}

export async function submitReview(actor: AuthUser, id: string, body: SubmitReviewBody): Promise<ReviewSubmitResult> {
  const { task, record } = await loadTask(actor, id)
  assertOpenForReview(task, record)
  assertLockOwner(actor, task)
  if (record.status !== 'in_review') throw new AppError('GONE', 'This review task is closed.', { reason: 'TASK_CLOSED' })
  await ensureConsentStillValid(record, id)

  const data = await loadWorkspaceData(record)
  const resources = resourcesOf(record, data)
  const fields: WorkspaceField[] = resources.flatMap((resource) => resource.fields)
  const admin = getSupabaseAdmin()

  if (body.overall === 'reject_record') {
    const corrections = fields.map((field) => ({
      field_key: field.field_key,
      action: 'reject',
      original_value: field.found ? field.value : null,
      corrected_value: null,
      original_code: field.coding ? { system: field.coding.system, code: field.coding.code, display: field.coding.display } : null,
      corrected_code: null,
      source_span: field.span,
      note: null,
    }))
    const { error } = await admin.rpc('reject_review', {
      p_task: id,
      p_reviewer: actor.userId,
      p_corrections: corrections,
      p_counts: { accepted: 0, corrected: 0, rejected: corrections.length },
    })
    if (error) throw mapSubmitError(error)
    return { status: 'rejected' }
  }

  const decisionIssues = checkDecisions(fields, body.decisions)
  if (decisionIssues.length > 0) throw decisionError(decisionIssues)

  const codeDisplays = await lookUpCodes(body.decisions.flatMap((decision) => (decision.code ? [decision.code] : [])))
  const storedRows: StoredField[] = data.fields
    .filter((row) => row.found && row.source_span !== null)
    .map((row) => ({ ...row, source_span: row.source_span as never, value: row.value }))
  const existingCodings = data.resources.flatMap((resource) => resource.codings) as Coding[]
  const { applied, issues: applyIssues } = applyDecisions({
    fields,
    storedRows,
    existingCodings,
    decisions: body.decisions,
    catalog: catalogFor(record.doc_type),
    codeDisplays,
  })
  if (applyIssues.length > 0) throw decisionError(applyIssues)

  if (!record.patient_id) throw new AppError('CONFLICT', 'This record has no patient.', { reason: 'PATIENT_MISSING' })
  const existingIds = new Map(data.resources.flatMap((resource) => (resource.source_ref ? [[resource.source_ref, resource.id] as const] : [])))
  const built = rebuildResources({ rows: applied.finalRows, codings: applied.codings, patientId: record.patient_id, existingIds, newId: () => randomUUID() })
  if (built.length === 0) throw new AppError('VALIDATION_FAILED', 'Nothing is left to commit after these decisions.', { reason: 'VALIDATION_FAILED' })

  const terminology = new SupabaseTerminologySearch()
  const results = await getFhirValidator().validate(
    built.map((entry) => entry.resource),
    {
      patientId: record.patient_id,
      resourceIds: new Set(built.map((entry) => entry.id)),
      now: new Date(),
      isKnownCode: (uri, code) => {
        const system = ({ 'http://snomed.info/sct': 'snomed', 'http://loinc.org': 'loinc', 'http://hl7.org/fhir/sid/icd-10': 'icd10' } as Record<string, CodeSystem>)[uri]
        return system ? terminology.exists(system, code) : Promise.resolve(true)
      },
    },
  )
  const failed = results.filter((result) => result.status === 'fail')
  if (failed.length > 0) {
    throw new AppError('VALIDATION_FAILED', 'A resource is not valid FHIR after these decisions. Nothing was committed.', {
      reason: 'VALIDATION_FAILED',
      details: {
        issues: failed.flatMap((result) => {
          const entry = built.find((candidate) => candidate.id === result.resourceId)
          return result.issues
            .filter((issue) => issue.severity === 'error')
            .map((issue) => ({ ...issue, resource_type: entry?.resourceType, source_ref: entry?.sourceRef }))
        }),
      },
    })
  }

  const keptIds = new Set(built.map((entry) => entry.id))
  const { data: committed, error } = await admin.rpc('submit_review', {
    p_task: id,
    p_reviewer: actor.userId,
    p_resources: built.map((entry) => ({
      id: entry.id,
      resource_type: entry.resourceType,
      resource: entry.resource,
      codings: entry.codings,
      flags: entry.flags,
      source_ref: entry.sourceRef,
      validation_issues: results.find((result) => result.resourceId === entry.id)?.issues ?? [],
      profile_url: entry.profileUrl,
    })),
    p_deleted_resources: data.resources.filter((resource) => !keptIds.has(resource.id)).map((resource) => resource.id),
    p_fields: applied.changed,
    p_removed_fields: applied.removed,
    p_corrections: applied.corrections,
    p_counts: applied.counts,
  })
  if (error) throw mapSubmitError(error)
  return { status: 'committed', fhir_resource_ids: Array.isArray(committed) ? (committed as string[]) : [] }
}

// ---------- re-upload request / terminology search ----------

export async function requestReupload(actor: AuthUser, id: string, body: ReuploadBody): Promise<void> {
  const { task, record } = await loadTask(actor, id)
  assertOpenForReview(task, record)
  assertLockOwner(actor, task)
  if (!record.status_reason || !REUPLOAD_REASONS.includes(record.status_reason)) {
    throw new AppError('CONFLICT', 'A new copy can only be requested for scan, file or language problems.', { reason: 'NOT_REUPLOADABLE' })
  }
  const { error } = await getSupabaseAdmin().from('review_tasks').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', id)
  if (error) fail('Failed to close the review task.', error)
  await setStatus(record, 'rejected', { reason: 'reupload_requested' })
  await appendAudit({
    orgId: actor.orgId,
    recordId: record.id,
    actor: { type: 'user', id: actor.userId },
    event: 'review.reupload_requested',
    payload: { task_id: id, note_length: body.note.length },
  })
}

export async function searchCodes(query: TerminologySearchQuery): Promise<TerminologyHit[]> {
  const hits = await new SupabaseTerminologySearch(getEmbeddingsClient()).search(
    query.q,
    query.system,
    query.resource_type as Parameters<SupabaseTerminologySearch['search']>[2],
    10,
  )
  return hits
}
