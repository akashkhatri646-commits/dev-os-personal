import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { actorNames, COLUMNS, hashChecks, rowSchema } from '@/server/services/audit/auditQuery'
import { appendAuditBestEffort } from '@/server/services/audit/auditLog'
import { promptVersionsOf } from '@/server/services/records/traceService'
import type { AuditEvent } from '@/types/audit'
import type { AuditRow } from '@/types/auditApi'
import type { AuthUser } from '@/types/domain'
import type { Reconstruction, ReconstructionCorrection } from '@/types/trace'

const MAX_CHAIN_ROWS = 500

function fail(message: string, cause: unknown): never {
  throw new AppError('INTERNAL', message, { cause })
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** The newest audit payload for an event, or null. */
function latestPayload(chain: readonly AuditRow[], event: AuditEvent): Record<string, unknown> | null {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const row = chain[index]
    if (row?.event === event) return row.payload
  }
  return null
}

const recordSchema = z.object({
  id: z.string(),
  status: z.string(),
  status_reason: z.string().nullable(),
  doc_type: z.string(),
  input_kind: z.string(),
  source_id: z.string(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
  cost_usd: z.coerce.number(),
  latency_ms: z.number().nullable(),
  holdback: z.boolean(),
  prompt_set: z.record(z.string(), z.unknown()).nullable(),
})

/**
 * Answers "why was this record committed or escalated?": the ordered audit chain joined with what
 * each stage stored. Admin only. The diff of reviewer corrections contains values from the record,
 * so reading this is itself audited (without any of those values).
 */
export async function reconstructRecord(actor: AuthUser, recordId: string): Promise<Reconstruction> {
  const admin = getSupabaseAdmin()
  const { data: recordData, error: recordError } = await admin
    .from('ingestion_records')
    .select('id, status, status_reason, doc_type, input_kind, source_id, created_at, completed_at, cost_usd, latency_ms, holdback, prompt_set')
    .eq('id', recordId)
    .eq('org_id', actor.orgId)
    .maybeSingle()
  if (recordError) fail('Failed to load the record.', recordError)
  if (!recordData) throw new AppError('NOT_FOUND', 'Record not found.')
  const record = recordSchema.parse(recordData)

  const [source, document, consent, auditRows, decision, resources, scores, tasks, corrections, fhir] = await Promise.all([
    admin.from('provider_sources').select('id, name').eq('id', record.source_id).maybeSingle(),
    admin.from('documents').select('ocr_engine, ocr_confidence, page_count').eq('record_id', recordId).limit(1).maybeSingle(),
    admin.from('consent_checks').select('result, regime, required_categories, matched_scope, checked_at, artifact_id').eq('record_id', recordId).maybeSingle(),
    admin.from('audit_log').select(COLUMNS).eq('org_id', actor.orgId).eq('record_id', recordId).order('id', { ascending: true }).limit(MAX_CHAIN_ROWS),
    admin.from('routing_decisions').select('decision, escalation_reasons, reasoning_trace, rule_version, thresholds_applied').eq('record_id', recordId).maybeSingle(),
    admin.from('mapped_resources').select('id, resource_type, validation_status, validation_issues, flags').eq('record_id', recordId),
    admin.from('field_scores').select('scope, resource_id, score').eq('record_id', recordId),
    admin.from('review_tasks').select('kind, status, claimed_by, claimed_at, completed_at').eq('record_id', recordId).order('created_at', { ascending: true }),
    admin.from('review_corrections').select('field_key, action, original_value, corrected_value, original_code, corrected_code, note, reviewer_id, reviewed_at').eq('record_id', recordId).order('reviewed_at', { ascending: true }),
    admin.from('fhir_resources').select('id, commit_mode, created_at').eq('record_id', recordId),
  ])
  for (const result of [source, document, consent, auditRows, decision, resources, scores, tasks, corrections, fhir]) {
    if (result.error) fail('Failed to load the record history.', result.error)
  }

  const stored = z.array(rowSchema).parse(auditRows.data ?? [])
  const [checks, names] = await Promise.all([hashChecks(actor.orgId, stored.map((row) => row.id)), actorNames(actor.orgId, stored)])
  const chain: AuditRow[] = stored.map((row) => ({
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

  const consentRow = consent.data
  const artifactRef = consentRow?.artifact_id ? ((await admin.from('consent_artifacts').select('artifact_ref').eq('id', consentRow.artifact_id as string).maybeSingle()).data?.artifact_ref as string | undefined) ?? null : null

  const claimerIds = [...new Set([...(tasks.data ?? []).map((row) => row.claimed_by), ...(corrections.data ?? []).map((row) => row.reviewer_id)].filter((value): value is string => typeof value === 'string'))]
  const profiles = claimerIds.length > 0 ? await admin.from('profiles').select('id, full_name, email').in('id', claimerIds) : { data: [], error: null }
  if (profiles.error) fail('Failed to load reviewers.', profiles.error)
  const reviewerName = new Map((profiles.data ?? []).map((row) => [row.id as string, ((row.full_name as string | null) ?? (row.email as string))]))

  const extraction = latestPayload(chain, 'extraction.completed')
  const mapping = latestPayload(chain, 'mapping.completed')
  const committedAt = chain.filter((row) => row.event === 'record.committed').at(-1)
  const commitMode = fhir.data?.[0]?.commit_mode as string | undefined

  const thresholds = Object.fromEntries(
    Object.entries((decision.data?.thresholds_applied ?? {}) as Record<string, unknown>).filter(([key, value]) => key !== '_checksum' && typeof value === 'object' && value !== null),
  ) as Record<string, { threshold: number; pass: boolean }>
  const typeById = new Map((resources.data ?? []).map((row) => [row.id as string, row.resource_type as string]))
  const scoreRows = scores.data ?? []
  const recordScore = scoreRows.find((row) => row.scope === 'record')

  await appendAuditBestEffort({ orgId: actor.orgId, recordId, actor: { type: 'user', id: actor.userId }, event: 'audit.reconstructed', payload: { chain_entries: chain.length } })

  return {
    record: {
      id: record.id,
      status: record.status as Reconstruction['record']['status'],
      status_reason: record.status_reason,
      doc_type: record.doc_type as Reconstruction['record']['doc_type'],
      input_kind: record.input_kind as Reconstruction['record']['input_kind'],
      source: { id: record.source_id, name: (source.data?.name as string | undefined) ?? 'Unknown source' },
      created_at: record.created_at,
      completed_at: record.completed_at,
      cost_usd: record.cost_usd,
      latency_ms: record.latency_ms,
      holdback: record.holdback,
    },
    consent: consentRow
      ? {
          result: consentRow.result as string,
          regime: consentRow.regime as string,
          required: consentRow.required_categories as string[],
          matched_scope: consentRow.matched_scope as string[],
          checked_at: consentRow.checked_at as string,
          artifact_ref: artifactRef,
        }
      : null,
    ocr: document.data ? { engine: (document.data.ocr_engine as string | null) ?? null, confidence: document.data.ocr_confidence === null ? null : Number(document.data.ocr_confidence), pages: (document.data.page_count as number | null) ?? null } : null,
    extraction: extraction
      ? {
          model_id: typeof record.prompt_set?.model_id === 'string' ? record.prompt_set.model_id : null,
          prompt_versions: promptVersionsOf(record.prompt_set),
          fields_found: num(extraction.fields_found),
          fields_not_found: num(extraction.fields_not_found),
          injection_suspected: record.prompt_set?.injection_suspected === true || latestPayload(chain, 'extraction.injection_suspected') !== null,
        }
      : null,
    mapping: mapping ? { resources: num(mapping.resources), coded: num(mapping.coded), uncoded: num(mapping.uncoded) } : null,
    validation: (resources.data ?? []).map((row) => ({
      resource_type: row.resource_type as string,
      status: row.validation_status as string,
      error_count: Array.isArray(row.validation_issues) ? row.validation_issues.filter((issue: { severity?: string }) => issue.severity === 'error').length : 0,
      flags: (row.flags as string[] | null) ?? [],
    })),
    scores: {
      aggregate: recordScore ? Number(recordScore.score) : null,
      resources: scoreRows
        .filter((row) => row.scope === 'resource')
        .map((row) => {
          const type = typeById.get(row.resource_id as string) ?? 'Resource'
          return { resource_type: type, score: Number(row.score), threshold: thresholds[type]?.threshold ?? null, pass: thresholds[type]?.pass ?? null }
        }),
    },
    routing: decision.data
      ? { decision: decision.data.decision as string, reasons: decision.data.escalation_reasons as string[], trace: decision.data.reasoning_trace as string, rule_version: decision.data.rule_version as string }
      : null,
    review: {
      tasks: (tasks.data ?? []).map((row) => ({
        kind: row.kind as string,
        status: row.status as string,
        claimed_by_name: row.claimed_by ? (reviewerName.get(row.claimed_by as string) ?? null) : null,
        claimed_at: (row.claimed_at as string | null) ?? null,
        completed_at: (row.completed_at as string | null) ?? null,
      })),
      corrections: (corrections.data ?? []).map<ReconstructionCorrection>((row) => ({
        field_key: row.field_key as string,
        action: row.action as ReconstructionCorrection['action'],
        original_value: row.original_value,
        corrected_value: row.corrected_value,
        original_code: row.original_code,
        corrected_code: row.corrected_code,
        note: (row.note as string | null) ?? null,
        reviewer_name: reviewerName.get(row.reviewer_id as string) ?? null,
        reviewed_at: row.reviewed_at as string,
      })),
    },
    commit: committedAt && commitMode ? { mode: commitMode, resource_ids: (fhir.data ?? []).map((row) => row.id as string), committed_at: committedAt.created_at } : null,
    chain,
  }
}
