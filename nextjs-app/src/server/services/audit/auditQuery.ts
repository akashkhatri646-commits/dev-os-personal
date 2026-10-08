import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { MAX_EXPORT_ROWS, type AuditExportInput, type AuditFilters, type AuditSearchInput } from '@/lib/validation/audit'
import { appendAudit } from '@/server/services/audit/auditLog'
import { hashPatientIdentifier } from '@/server/services/patients/patientIdentifiers'
import type { AuditEvent } from '@/types/audit'
import type { AuditRow, AuditVerifyResult } from '@/types/auditApi'
import type { AuthUser } from '@/types/domain'

const EXPORT_PAGE_SIZE = 1000

export const rowSchema = z.object({
  id: z.number(),
  created_at: z.string(),
  actor_type: z.enum(['user', 'system', 'api_key']),
  actor_id: z.string().nullable(),
  event: z.string(),
  record_id: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  hash: z.string(),
  prev_hash: z.string().nullable(),
})
export type StoredRow = z.infer<typeof rowSchema>

export const COLUMNS = 'id, created_at, actor_type, actor_id, event, record_id, payload, hash, prev_hash'

function encodeCursor(id: number): string {
  return Buffer.from(String(id), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): number {
  const id = Number(Buffer.from(cursor, 'base64url').toString('utf8'))
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AppError('VALIDATION_FAILED', 'Invalid pagination cursor.', {
      details: [{ path: ['cursor'], message: 'Invalid cursor' }],
    })
  }
  return id
}

/** Patient ids in the organisation matching an identifier, looked up by HMAC hash only. */
async function resolvePatientIds(orgId: string, identifier: NonNullable<AuditFilters['patient_identifier']>) {
  const hash = hashPatientIdentifier(identifier)
  const column = identifier.type === 'abha' ? 'abha_hash' : 'mrn_hash'
  const { data, error } = await getSupabaseAdmin()
    .from('patients')
    .select('id')
    .eq('org_id', orgId)
    .eq(column, hash)
  if (error) throw new AppError('INTERNAL', 'Failed to resolve the patient filter.', { cause: error })
  return (data ?? []).map((row) => row.id as string)
}

interface ResolvedScope {
  /** Null when no patient filter is set; an empty list means "matches nothing". */
  patientIds: string[] | null
  needsRecordJoin: boolean
}

async function resolveScope(actor: AuthUser, filters: AuditFilters): Promise<ResolvedScope> {
  const patientIds = filters.patient_identifier
    ? await resolvePatientIds(actor.orgId, filters.patient_identifier)
    : null
  return { patientIds, needsRecordJoin: Boolean(filters.source_id) || patientIds !== null }
}

/** Builds the filtered, org-scoped query. The record join is inner only when a filter needs it. */
function buildQuery(
  actor: AuthUser,
  filters: AuditFilters,
  scope: ResolvedScope,
  options: { head?: boolean; afterId?: number; limit?: number },
) {
  const select = scope.needsRecordJoin ? `${COLUMNS}, ingestion_records!inner(source_id, patient_id)` : COLUMNS
  let query = getSupabaseAdmin()
    .from('audit_log')
    .select(select, options.head ? { count: 'exact', head: true } : undefined)
    .eq('org_id', actor.orgId)

  if (filters.record_id) query = query.eq('record_id', filters.record_id)
  if (filters.source_id) query = query.eq('ingestion_records.source_id', filters.source_id)
  if (scope.patientIds) query = query.in('ingestion_records.patient_id', scope.patientIds)
  if (filters.events && filters.events.length > 0) query = query.in('event', filters.events)
  if (filters.actor_id) query = query.eq('actor_id', filters.actor_id)
  if (filters.from) query = query.gte('created_at', filters.from)
  if (filters.to) query = query.lte('created_at', filters.to)
  if (options.afterId !== undefined) query = query.lt('id', options.afterId)
  if (!options.head) {
    query = query.order('id', { ascending: false })
    if (options.limit) query = query.limit(options.limit)
  }
  return query
}

async function fetchRows(
  actor: AuthUser,
  filters: AuditFilters,
  scope: ResolvedScope,
  options: { afterId?: number; limit: number },
): Promise<StoredRow[]> {
  if (scope.patientIds && scope.patientIds.length === 0) return []
  const { data, error } = await buildQuery(actor, filters, scope, options)
  if (error) throw new AppError('INTERNAL', 'Failed to load audit entries.', { cause: error })
  return z.array(rowSchema).parse(data ?? [])
}

export async function hashChecks(orgId: string, ids: number[]): Promise<Map<number, boolean>> {
  const result = new Map<number, boolean>()
  if (ids.length === 0) return result
  const { data, error } = await getSupabaseAdmin().rpc('check_audit_rows', { p_org: orgId, p_ids: ids })
  if (error) throw new AppError('INTERNAL', 'Failed to verify audit entries.', { cause: error })
  for (const row of z.array(z.object({ id: z.number(), hash_ok: z.boolean().nullable() })).parse(data ?? [])) {
    result.set(row.id, row.hash_ok === true)
  }
  return result
}

export async function actorNames(orgId: string, rows: StoredRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.filter((row) => row.actor_type === 'user' && row.actor_id).map((row) => row.actor_id as string))]
  const names = new Map<string, string>()
  if (ids.length === 0) return names
  const { data } = await getSupabaseAdmin().from('profiles').select('id, full_name').eq('org_id', orgId).in('id', ids)
  for (const row of data ?? []) {
    if (row.full_name) names.set(row.id as string, row.full_name as string)
  }
  return names
}

export async function searchAudit(
  actor: AuthUser,
  input: AuditSearchInput,
): Promise<{ rows: AuditRow[]; nextCursor: string | null }> {
  const { limit, cursor, ...filters } = input
  const scope = await resolveScope(actor, filters)
  const fetched = await fetchRows(actor, filters, scope, {
    afterId: cursor ? decodeCursor(cursor) : undefined,
    limit: limit + 1,
  })

  const hasMore = fetched.length > limit
  const page = hasMore ? fetched.slice(0, limit) : fetched
  const [checks, names] = await Promise.all([
    hashChecks(actor.orgId, page.map((row) => row.id)),
    actorNames(actor.orgId, page),
  ])

  const rows = page.map<AuditRow>((row) => ({
    id: row.id,
    created_at: row.created_at,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    actor_name: row.actor_id ? (names.get(row.actor_id) ?? null) : null,
    event: row.event as AuditEvent,
    record_id: row.record_id,
    payload: row.payload,
    hash_short: row.hash.slice(0, 12),
    hash_ok: checks.get(row.id) === true,
  }))
  const last = page[page.length - 1]
  return { rows, nextCursor: hasMore && last ? encodeCursor(last.id) : null }
}

/** Full-chain verification for the organisation; `first_broken_id` is set when tampering is detected. */
export async function verifyChain(actor: AuthUser): Promise<AuditVerifyResult> {
  const { data, error } = await getSupabaseAdmin().rpc('verify_audit_chain', { p_org: actor.orgId })
  if (error) throw new AppError('INTERNAL', 'Failed to verify the audit chain.', { cause: error })
  const firstBroken = z.number().nullable().parse(data ?? null)
  return { ok: firstBroken === null, first_broken_id: firstBroken }
}

/** Escapes one CSV cell, neutralising spreadsheet formula injection. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const CSV_HEADER = ['id', 'created_at', 'actor_type', 'actor_id', 'event', 'record_id', 'payload', 'hash', 'prev_hash']

export interface AuditExportFile {
  body: string
  contentType: string
  filename: string
  rowCount: number
}

/**
 * Exports every matching entry (max 50,000) as CSV or JSON. The export itself is audited with the
 * names of the filters used, never their values (a patient identifier must not reach the audit log).
 */
export async function exportAudit(actor: AuthUser, input: AuditExportInput): Promise<AuditExportFile> {
  const { format, ...filters } = input
  const scope = await resolveScope(actor, filters)

  let total = 0
  if (!(scope.patientIds && scope.patientIds.length === 0)) {
    const { count, error } = await buildQuery(actor, filters, scope, { head: true })
    if (error) throw new AppError('INTERNAL', 'Failed to count audit entries.', { cause: error })
    total = count ?? 0
  }
  if (total > MAX_EXPORT_ROWS) {
    throw new AppError('VALIDATION_FAILED', `Too many entries to export (${total}). Narrow the filters to ${MAX_EXPORT_ROWS} or fewer.`, {
      reason: 'TOO_MANY_ROWS',
    })
  }

  const rows: StoredRow[] = []
  let afterId: number | undefined
  while (rows.length < total) {
    const page = await fetchRows(actor, filters, scope, { afterId, limit: EXPORT_PAGE_SIZE })
    if (page.length === 0) break
    rows.push(...page)
    afterId = page[page.length - 1]?.id
  }

  await appendAudit({
    orgId: actor.orgId,
    actor: { type: 'user', id: actor.userId },
    event: 'audit.exported',
    payload: {
      format,
      row_count: rows.length,
      filters: Object.entries(filters)
        .filter(([, value]) => value !== undefined)
        .map(([name]) => name),
    },
  })

  const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-')
  if (format === 'json') {
    return {
      body: JSON.stringify(rows, null, 2),
      contentType: 'application/json; charset=utf-8',
      filename: `audit-${stamp}.json`,
      rowCount: rows.length,
    }
  }
  const lines = [CSV_HEADER.join(',')]
  for (const row of rows) {
    lines.push(
      [row.id, row.created_at, row.actor_type, row.actor_id, row.event, row.record_id, row.payload, row.hash, row.prev_hash]
        .map(csvCell)
        .join(','),
    )
  }
  return {
    body: `${lines.join('\r\n')}\r\n`,
    contentType: 'text/csv; charset=utf-8',
    filename: `audit-${stamp}.csv`,
    rowCount: rows.length,
  }
}
