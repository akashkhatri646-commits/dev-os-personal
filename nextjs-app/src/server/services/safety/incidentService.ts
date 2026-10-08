import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { buildPage, cursorFilter, decodeCursor } from '@/lib/api/pagination'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import type { BulkReviewBody, ErrorReportBody, ListIncidentsQuery, PauseAllBody, UpdateIncidentBody } from '@/lib/validation/safety'
import { loadRecord } from '@/server/pipeline/orchestrator'
import { sendAlert } from '@/server/services/alerts/alerts'
import { appendAudit } from '@/server/services/audit/auditLog'
import { markEnteredInError } from '@/server/services/fhir/supersede'
import { createReviewTask } from '@/server/services/review/tasks'
import { pauseSource } from '@/server/services/sources/sourceService'
import type { AuthUser } from '@/types/domain'
import type { BulkReviewResult, Incident } from '@/types/safety'

/** A downstream error review is reviewed before everything else (the column holds up to 999.999). */
export const INCIDENT_TASK_PRIORITY = 999
export const BULK_TASK_PRIORITY = 500
const PAUSING_SEVERITIES = ['medium', 'high', 'critical']

function fail(message: string, cause: unknown): never {
  throw new AppError('INTERNAL', message, { cause })
}

const incidentRowSchema = z.object({
  id: z.string(),
  record_id: z.string(),
  fhir_resource_id: z.string().nullable(),
  reported_by: z.string(),
  description: z.string(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  status: z.enum(['open', 'investigating', 'resolved']),
  source_paused: z.boolean(),
  root_cause: z.enum(['extraction', 'mapping', 'ocr', 'threshold', 'consent', 'other']).nullable(),
  resolution_note: z.string().nullable(),
  resolved_at: z.string().nullable(),
  created_at: z.string(),
  ingestion_records: z.object({ source_id: z.string(), provider_sources: z.object({ name: z.string() }).nullable() }),
})

const COLUMNS =
  'id, record_id, fhir_resource_id, reported_by, description, severity, status, source_paused, root_cause, resolution_note, resolved_at, created_at, ingestion_records!inner(source_id, provider_sources(name))'

async function toIncidents(rows: z.infer<typeof incidentRowSchema>[]): Promise<Incident[]> {
  const ids = [...new Set(rows.map((row) => row.reported_by))]
  const { data, error } = ids.length > 0 ? await getSupabaseAdmin().from('profiles').select('id, full_name, email').in('id', ids) : { data: [], error: null }
  if (error) fail('Failed to load reporters.', error)
  const names = new Map((data ?? []).map((row) => [row.id as string, ((row.full_name as string | null) ?? (row.email as string))]))
  return rows.map((row) => ({
    id: row.id,
    record_id: row.record_id,
    fhir_resource_id: row.fhir_resource_id,
    source_id: row.ingestion_records.source_id,
    source_name: row.ingestion_records.provider_sources?.name ?? 'Unknown source',
    severity: row.severity,
    status: row.status,
    description: row.description,
    source_paused: row.source_paused,
    reported_by_name: names.get(row.reported_by) ?? null,
    root_cause: row.root_cause,
    resolution_note: row.resolution_note,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  }))
}

async function loadIncident(actor: AuthUser, id: string): Promise<Incident> {
  const { data, error } = await getSupabaseAdmin().from('downstream_errors').select(COLUMNS).eq('id', id).eq('org_id', actor.orgId).maybeSingle()
  if (error) fail('Failed to load the incident.', error)
  if (!data) throw new AppError('NOT_FOUND', 'Incident not found.')
  const [incident] = await toIncidents([incidentRowSchema.parse(data)])
  if (!incident) throw new AppError('NOT_FOUND', 'Incident not found.')
  return incident
}

/**
 * Records a confirmed downstream error. From medium severity it stops the source's auto-commit at
 * once, marks the reported resource as entered in error (superseded, never deleted), and queues a
 * review of the record ahead of everything else. Low severity only queues the review.
 */
export async function reportDownstreamError(actor: AuthUser, recordId: string, body: ErrorReportBody): Promise<Incident> {
  const record = await loadRecord(recordId)
  if (!record || record.org_id !== actor.orgId) throw new AppError('NOT_FOUND', 'Record not found.')

  const admin = getSupabaseAdmin()
  let resource: { id: string; resource: Record<string, unknown> } | null = null
  if (body.fhir_resource_id) {
    const { data, error } = await admin.from('fhir_resources').select('id, resource').eq('id', body.fhir_resource_id).eq('record_id', recordId).maybeSingle()
    if (error) fail('Failed to load the resource.', error)
    if (!data) throw new AppError('NOT_FOUND', 'That resource does not belong to this record.')
    resource = { id: data.id as string, resource: data.resource as Record<string, unknown> }
  }

  const pausing = PAUSING_SEVERITIES.includes(body.severity)
  const { data: inserted, error: insertError } = await admin
    .from('downstream_errors')
    .insert({
      org_id: actor.orgId,
      record_id: recordId,
      fhir_resource_id: body.fhir_resource_id ?? null,
      reported_by: actor.userId,
      description: body.description,
      severity: body.severity,
      source_paused: pausing,
    })
    .select('id')
    .single()
  if (insertError || !inserted) fail('Failed to record the error.', insertError)
  const incidentId = inserted.id as string

  if (pausing) {
    await pauseSource(actor, record.source_id, `Downstream error reported (${body.severity})`)
    if (resource) {
      const { error } = await admin.from('fhir_resources').update({ resource: markEnteredInError(resource.resource) }).eq('id', resource.id)
      if (error) fail('Failed to mark the resource as entered in error.', error)
    }
  }
  await createReviewTask(recordId, 'downstream_error_review', INCIDENT_TASK_PRIORITY)

  await appendAudit({
    orgId: actor.orgId,
    recordId,
    actor: { type: 'user', id: actor.userId },
    event: 'error.reported',
    payload: { error_id: incidentId, severity: body.severity, source_id: record.source_id, source_paused: pausing, resource_marked: pausing && resource !== null },
  })
  if (body.severity === 'high' || body.severity === 'critical') {
    await sendAlert({ kind: 'downstream_error', message: `A ${body.severity} downstream error was reported for record ${recordId}. Source ${record.source_id} was paused.` })
  }
  return loadIncident(actor, incidentId)
}

export async function listIncidents(actor: AuthUser, query: ListIncidentsQuery): Promise<{ incidents: Incident[]; nextCursor: string | null }> {
  let builder = getSupabaseAdmin()
    .from('downstream_errors')
    .select(COLUMNS)
    .eq('org_id', actor.orgId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(query.limit + 1)
  if (query.status) builder = builder.eq('status', query.status)
  if (query.cursor) builder = builder.or(cursorFilter(decodeCursor(query.cursor)))
  const { data, error } = await builder
  if (error) fail('Failed to list incidents.', error)
  const { items, nextCursor } = buildPage(z.array(incidentRowSchema).parse(data ?? []), query.limit)
  return { incidents: await toIncidents(items), nextCursor }
}

/** Moves an incident along. Resolving needs a root cause, and closes the review task raised for it. */
export async function updateIncident(actor: AuthUser, id: string, body: UpdateIncidentBody): Promise<Incident> {
  const current = await loadIncident(actor, id)
  if (current.status === 'resolved') throw new AppError('CONFLICT', 'This incident is already resolved.', { reason: 'ALREADY_RESOLVED' })

  const admin = getSupabaseAdmin()
  const resolved = body.status === 'resolved'
  const { error } = await admin
    .from('downstream_errors')
    .update({
      status: body.status,
      ...(body.root_cause ? { root_cause: body.root_cause } : {}),
      ...(body.note ? { resolution_note: body.note } : {}),
      ...(resolved ? { resolved_by: actor.userId, resolved_at: new Date().toISOString() } : {}),
    })
    .eq('id', id)
    .eq('org_id', actor.orgId)
  if (error) fail('Failed to update the incident.', error)

  if (resolved) {
    const { error: taskError } = await admin
      .from('review_tasks')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('record_id', current.record_id)
      .eq('kind', 'downstream_error_review')
      .in('status', ['open', 'claimed'])
    if (taskError) fail('Failed to close the review task.', taskError)
  }
  await appendAudit({
    orgId: actor.orgId,
    recordId: current.record_id,
    actor: { type: 'user', id: actor.userId },
    event: 'error.updated',
    payload: { error_id: id, status: body.status, ...(body.root_cause ? { root_cause: body.root_cause } : {}) },
  })
  return loadIncident(actor, id)
}

/** Queues a downstream-error review for each record (for example everything auto-committed under a bad prompt). */
export async function bulkCreateReviews(actor: AuthUser, body: BulkReviewBody): Promise<BulkReviewResult> {
  const admin = getSupabaseAdmin()
  const ids = [...new Set(body.record_ids)]
  const { data: records, error } = await admin.from('ingestion_records').select('id').eq('org_id', actor.orgId).in('id', ids)
  if (error) fail('Failed to load the records.', error)
  const owned = (records ?? []).map((row) => row.id as string)
  if (owned.length !== ids.length) throw new AppError('NOT_FOUND', 'Some records were not found.', { reason: 'RECORDS_NOT_FOUND' })

  const { data: open, error: openError } = await admin
    .from('review_tasks')
    .select('record_id')
    .eq('kind', 'downstream_error_review')
    .in('status', ['open', 'claimed'])
    .in('record_id', owned)
  if (openError) fail('Failed to check existing tasks.', openError)
  const already = new Set((open ?? []).map((row) => row.record_id as string))

  for (const recordId of owned.filter((id) => !already.has(id))) await createReviewTask(recordId, 'downstream_error_review', BULK_TASK_PRIORITY)
  const created = owned.length - already.size
  await appendAudit({ orgId: actor.orgId, actor: { type: 'user', id: actor.userId }, event: 'review.bulk_created', payload: { created, already_open: already.size } })
  return { created, already_open: already.size }
}

/** Emergency stop: pauses auto-commit on every source of the organisation that has it on. */
export async function pauseAllSources(actor: AuthUser, body: PauseAllBody): Promise<{ paused: number }> {
  const { data, error } = await getSupabaseAdmin().from('provider_sources').select('id').eq('org_id', actor.orgId).eq('auto_commit_enabled', true)
  if (error) fail('Failed to list sources.', error)
  const ids = (data ?? []).map((row) => row.id as string)
  for (const id of ids) await pauseSource(actor, id, body.reason)
  await appendAudit({ orgId: actor.orgId, actor: { type: 'user', id: actor.userId }, event: 'source.paused_all', payload: { sources: ids.length } })
  if (ids.length > 0) await sendAlert({ kind: 'sources_paused', message: `All auto-commit sources (${ids.length}) were paused by an admin.` })
  return { paused: ids.length }
}
