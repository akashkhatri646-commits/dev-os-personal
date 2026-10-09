import { assertEvaluationCurrent, resetEvaluation } from '@/server/services/evaluation/evaluationService'
import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { buildPage, cursorFilter, decodeCursor } from '@/lib/api/pagination'
import {
  MIN_HOLDBACK_PCT_WHEN_ENABLED,
  resolveThreshold,
  thresholdFloor,
  type ActiveThreshold,
} from '@/lib/sources/rules'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import type {
  CreateSourceInput,
  SetThresholdInput,
  UpdateSourceInput,
} from '@/lib/validation/sources'
import { getRuntimeConfig } from '@/server/config/constants'
import { appendAudit } from '@/server/services/audit/auditLog'
import { generateSourceKey, hashSourceKey } from '@/server/services/sources/sourceKeys'
import type { AuthUser } from '@/types/domain'
import type {
  CreatedSource,
  SourceDetail,
  SourceStatus,
  SourceSummary,
  ThresholdVersion,
} from '@/types/sources'

const docTypeEnum = z.enum(['discharge_summary', 'lab_report', 'other'])

const sourceRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider_type: z.enum(['hospital', 'lab', 'clinic']),
  size_class: z.enum(['small', 'medium', 'large']),
  region: z.string().nullable(),
  primary_language: z.string(),
  doc_types: z.array(docTypeEnum),
  consent_regime: z.enum(['abdm', 'hipaa']),
  auto_commit_enabled: z.boolean(),
  pause_reason: z.string().nullable(),
  eval_status: z.enum(['none', 'passed', 'failed']),
  eval_passed_at: z.string().nullable(),
  eval_basis: z.enum(['synthetic', 'real']).nullable().default(null),
  holdback_pct: z.coerce.number(),
  flagged_poor: z.boolean(),
  created_at: z.string(),
})
type SourceRow = z.infer<typeof sourceRowSchema>

const thresholdRowSchema = z.object({
  resource_type: z.string(),
  threshold: z.coerce.number(),
  version: z.number(),
  active: z.boolean(),
  reason: z.string(),
  changed_by: z.string().nullable(),
  created_at: z.string(),
})

const SOURCE_COLUMNS =
  'id, name, provider_type, size_class, region, primary_language, doc_types, consent_regime, auto_commit_enabled, pause_reason, eval_status, eval_passed_at, eval_basis, holdback_pct, flagged_poor, created_at'

const UNIQUE_VIOLATION = '23505'

export function deriveStatus(source: Pick<SourceRow, 'auto_commit_enabled' | 'pause_reason'>): SourceStatus {
  if (source.auto_commit_enabled) return 'auto_commit'
  return source.pause_reason ? 'paused' : 'manual_only'
}

function nameTaken(): AppError {
  return new AppError('CONFLICT', 'A source with this name already exists.', { reason: 'NAME_TAKEN' })
}

/** Rejects document types that are not enabled yet (MVP: discharge summaries only). */
function assertDocTypesEnabled(docTypes: readonly string[]): void {
  const enabled = getRuntimeConfig().enabledDocTypes
  const disabled = docTypes.filter((type) => !enabled.includes(type))
  if (disabled.length > 0) {
    throw new AppError('VALIDATION_FAILED', `Document type not enabled yet: ${disabled.join(', ')}.`, {
      reason: 'DOC_TYPE_NOT_ENABLED',
    })
  }
}

/** Loads a source the actor's organisation owns (service role, explicit org filter). 404 otherwise. */
async function loadOwnedSource(actor: AuthUser, id: string): Promise<SourceRow> {
  const { data, error } = await getSupabaseAdmin()
    .from('provider_sources')
    .select(SOURCE_COLUMNS)
    .eq('id', id)
    .eq('org_id', actor.orgId)
    .maybeSingle()
  if (error) throw new AppError('INTERNAL', 'Failed to load the source.', { cause: error })
  if (!data) throw new AppError('NOT_FOUND', 'Source not found.')
  return sourceRowSchema.parse(data)
}

async function activeThresholdsBySource(sourceIds: string[]): Promise<Map<string, Record<string, number>>> {
  const result = new Map<string, Record<string, number>>()
  if (sourceIds.length === 0) return result
  const { data, error } = await getSupabaseAdmin()
    .from('routing_thresholds')
    .select('source_id, resource_type, threshold')
    .in('source_id', sourceIds)
    .eq('active', true)
  if (error) throw new AppError('INTERNAL', 'Failed to load thresholds.', { cause: error })
  for (const row of data ?? []) {
    const sourceId = row.source_id as string
    const entry = result.get(sourceId) ?? {}
    entry[row.resource_type as string] = Number(row.threshold)
    result.set(sourceId, entry)
  }
  return result
}

async function queueDepthBySource(sourceIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (sourceIds.length === 0) return result
  const { data, error } = await getSupabaseAdmin()
    .from('review_tasks')
    .select('id, ingestion_records!inner(source_id)')
    .in('status', ['open', 'claimed'])
    .in('ingestion_records.source_id', sourceIds)
  if (error) throw new AppError('INTERNAL', 'Failed to load queue depth.', { cause: error })
  for (const row of data ?? []) {
    const record = row.ingestion_records as { source_id: string } | { source_id: string }[] | null
    const sourceId = Array.isArray(record) ? record[0]?.source_id : record?.source_id
    if (sourceId) result.set(sourceId, (result.get(sourceId) ?? 0) + 1)
  }
  return result
}

function toSummary(
  row: SourceRow,
  thresholds: Record<string, number> | undefined,
  queueDepth: number | undefined,
): SourceSummary {
  return {
    id: row.id,
    name: row.name,
    provider_type: row.provider_type,
    size_class: row.size_class,
    region: row.region,
    primary_language: row.primary_language,
    doc_types: row.doc_types,
    auto_commit_enabled: row.auto_commit_enabled,
    pause_reason: row.pause_reason,
    eval_status: row.eval_status,
    eval_basis: row.eval_basis,
    holdback_pct: row.holdback_pct,
    flagged_poor: row.flagged_poor,
    status: deriveStatus(row),
    queue_depth: queueDepth ?? 0,
    thresholds: thresholds ?? {},
    created_at: row.created_at,
  }
}

export async function listSources(
  actor: AuthUser,
  options: { limit: number; cursor?: string },
): Promise<{ sources: SourceSummary[]; nextCursor: string | null }> {
  // RLS applies to this read; the explicit org filter is defence in depth.
  let query = createSupabaseServerClient(actor.accessToken)
    .from('provider_sources')
    .select(SOURCE_COLUMNS)
    .eq('org_id', actor.orgId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(options.limit + 1)
  if (options.cursor) query = query.or(cursorFilter(decodeCursor(options.cursor)))

  const { data, error } = await query
  if (error) throw new AppError('INTERNAL', 'Failed to load sources.', { cause: error })

  const rows = z.array(sourceRowSchema).parse(data ?? [])
  const { items, nextCursor } = buildPage(rows, options.limit)
  const ids = items.map((item) => item.id)
  const [thresholds, depth] = await Promise.all([activeThresholdsBySource(ids), queueDepthBySource(ids)])

  return {
    sources: items.map((row) => toSummary(row, thresholds.get(row.id), depth.get(row.id))),
    nextCursor,
  }
}

export async function getSource(actor: AuthUser, id: string): Promise<SourceDetail> {
  const supabase = createSupabaseServerClient(actor.accessToken)
  const { data, error } = await supabase
    .from('provider_sources')
    .select(SOURCE_COLUMNS)
    .eq('id', id)
    .eq('org_id', actor.orgId)
    .maybeSingle()
  if (error) throw new AppError('INTERNAL', 'Failed to load the source.', { cause: error })
  if (!data) throw new AppError('NOT_FOUND', 'Source not found.')
  const row = sourceRowSchema.parse(data)

  const admin = getSupabaseAdmin()
  const [history, keyResult, evalResult, depth] = await Promise.all([
    supabase
      .from('routing_thresholds')
      .select('resource_type, threshold, version, active, reason, changed_by, created_at')
      .eq('source_id', id)
      .order('resource_type', { ascending: true })
      .order('version', { ascending: false }),
    admin
      .from('source_api_keys')
      .select('key_prefix')
      .eq('source_id', id)
      .is('revoked_at', null)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('eval_runs')
      .select('passed, ran_at, sample_count')
      .eq('source_id', id)
      .order('ran_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    queueDepthBySource([id]),
  ])
  if (history.error) throw new AppError('INTERNAL', 'Failed to load thresholds.', { cause: history.error })

  const versions = z.array(thresholdRowSchema).parse(history.data ?? [])
  const active: Record<string, number> = {}
  for (const version of versions) if (version.active) active[version.resource_type] = version.threshold

  const evalRow = evalResult.data
    ? z
        .object({ passed: z.boolean(), ran_at: z.string(), sample_count: z.number() })
        .parse(evalResult.data)
    : null

  return {
    ...toSummary(row, active, depth.get(id)),
    consent_regime: row.consent_regime,
    eval_passed_at: row.eval_passed_at,
    key_prefix: (keyResult.data?.key_prefix as string | undefined) ?? null,
    thresholds_detail: versions,
    latest_eval: evalRow,
  }
}

/**
 * Creates a source with its default thresholds and one API key in a single database transaction.
 * The plaintext key is returned once; only its peppered hash is stored.
 */
export async function createSource(actor: AuthUser, input: CreateSourceInput): Promise<CreatedSource> {
  if (input.consent_regime !== 'abdm') {
    throw new AppError('VALIDATION_FAILED', 'Only the ABDM consent regime is enabled.', {
      reason: 'REGIME_NOT_ENABLED',
    })
  }
  assertDocTypesEnabled(input.doc_types)

  const config = getRuntimeConfig()
  const { key, prefix } = generateSourceKey()
  const { data, error } = await getSupabaseAdmin().rpc('create_source_with_defaults', {
    p_org: actor.orgId,
    p_created_by: actor.userId,
    p_name: input.name,
    p_provider_type: input.provider_type,
    p_size_class: input.size_class,
    p_region: input.region ?? null,
    p_language: input.primary_language,
    p_doc_types: input.doc_types,
    p_regime: input.consent_regime,
    p_holdback: config.holdbackPctDefault,
    p_default_threshold: config.defaultThreshold,
    p_high_risk_threshold: config.highRiskThreshold,
    p_key_prefix: prefix,
    p_key_hash: hashSourceKey(key),
  })
  if (error) {
    if (error.code === UNIQUE_VIOLATION) throw nameTaken()
    throw new AppError('INTERNAL', 'Failed to create the source.', { cause: error })
  }

  const id = z.string().parse(data)
  await appendAudit({
    orgId: actor.orgId,
    actor: { type: 'user', id: actor.userId },
    event: 'source.created',
    payload: { source_id: id, provider_type: input.provider_type, size_class: input.size_class },
  })
  return { id, api_key: key }
}

export async function updateSource(
  actor: AuthUser,
  id: string,
  input: UpdateSourceInput,
): Promise<SourceDetail> {
  const existing = await loadOwnedSource(actor, id)

  if (input.doc_types) assertDocTypesEnabled(input.doc_types)
  if (
    input.holdback_pct !== undefined &&
    input.holdback_pct < MIN_HOLDBACK_PCT_WHEN_ENABLED &&
    existing.auto_commit_enabled
  ) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Holdback below ${MIN_HOLDBACK_PCT_WHEN_ENABLED}% is not allowed while auto-commit is enabled.`,
      { reason: 'HOLDBACK_TOO_LOW' },
    )
  }

  const { error } = await getSupabaseAdmin()
    .from('provider_sources')
    .update(input)
    .eq('id', id)
    .eq('org_id', actor.orgId)
  if (error) {
    if (error.code === UNIQUE_VIOLATION) throw nameTaken()
    throw new AppError('INTERNAL', 'Failed to update the source.', { cause: error })
  }

  await appendAudit({
    orgId: actor.orgId,
    actor: { type: 'user', id: actor.userId },
    event: 'source.updated',
    payload: { source_id: id, fields: Object.keys(input) },
  })
  return getSource(actor, id)
}

/** Appends a new threshold version (previous version deactivated atomically in the database). */
export async function setThreshold(
  actor: AuthUser,
  sourceId: string,
  input: SetThresholdInput,
): Promise<{ version: number; previous: number | null }> {
  await loadOwnedSource(actor, sourceId)

  const floor = thresholdFloor(input.resource_type)
  if (input.threshold < floor) {
    throw new AppError('VALIDATION_FAILED', `${input.resource_type} threshold cannot be below ${floor}.`, {
      reason: 'THRESHOLD_TOO_LOW',
    })
  }

  const { data, error } = await getSupabaseAdmin().rpc('set_routing_threshold', {
    p_source: sourceId,
    p_resource_type: input.resource_type,
    p_threshold: input.threshold,
    p_reason: input.reason,
    p_changed_by: actor.userId,
  })
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      throw new AppError('CONFLICT', 'The threshold was changed concurrently. Reload and retry.')
    }
    if (error.message.includes('not_found')) throw new AppError('NOT_FOUND', 'Source not found.')
    throw new AppError('INTERNAL', 'Failed to change the threshold.', { cause: error })
  }

  const result = z
    .array(z.object({ version: z.number(), previous: z.coerce.number().nullable() }))
    .min(1)
    .parse(data)[0]
  if (!result) throw new AppError('INTERNAL', 'Threshold change returned no result.')

  await appendAudit({
    orgId: actor.orgId,
    actor: { type: 'user', id: actor.userId },
    event: 'threshold.changed',
    payload: {
      source_id: sourceId,
      resource_type: input.resource_type,
      old: result.previous,
      new: input.threshold,
      version: result.version,
    },
  })
  // A pass was earned under the old thresholds: it no longer covers the new ones.
  await resetEvaluation({ orgId: actor.orgId, sourceId, actorId: actor.userId, reason: 'thresholds_changed' })
  return result
}

export async function getThresholdHistory(actor: AuthUser, sourceId: string): Promise<ThresholdVersion[]> {
  await loadOwnedSource(actor, sourceId)
  const { data, error } = await createSupabaseServerClient(actor.accessToken)
    .from('routing_thresholds')
    .select('resource_type, threshold, version, active, reason, changed_by, created_at')
    .eq('source_id', sourceId)
    .order('created_at', { ascending: false })
  if (error) throw new AppError('INTERNAL', 'Failed to load threshold history.', { cause: error })
  return z.array(thresholdRowSchema).parse(data ?? [])
}

/** Active thresholds for a source, loaded once per record by the routing stage. */
export async function loadActiveThresholds(sourceId: string): Promise<ActiveThreshold[]> {
  const { data, error } = await getSupabaseAdmin()
    .from('routing_thresholds')
    .select('resource_type, threshold, version')
    .eq('source_id', sourceId)
    .eq('active', true)
  if (error) throw new AppError('INTERNAL', 'Failed to load thresholds.', { cause: error })
  return (data ?? []).map((row) => ({
    resource_type: row.resource_type as string,
    threshold: Number(row.threshold),
    version: row.version as number,
  }))
}

export async function getEffectiveThreshold(sourceId: string, resourceType: string) {
  return resolveThreshold(await loadActiveThresholds(sourceId), resourceType)
}

export async function rotateKey(actor: AuthUser, id: string): Promise<{ api_key: string }> {
  await loadOwnedSource(actor, id)
  const { key, prefix } = generateSourceKey()
  const { error } = await getSupabaseAdmin().rpc('rotate_source_key', {
    p_source: id,
    p_key_prefix: prefix,
    p_key_hash: hashSourceKey(key),
  })
  if (error) throw new AppError('INTERNAL', 'Failed to rotate the key.', { cause: error })
  await appendAudit({
    orgId: actor.orgId,
    actor: { type: 'user', id: actor.userId },
    event: 'source.key_rotated',
    payload: { source_id: id },
  })
  return { api_key: key }
}

/** First-time enablement of auto-commit. Requires a passed onboarding eval and an unpaused source. */
export async function enableAutoCommit(actor: AuthUser, id: string, note: string): Promise<SourceDetail> {
  const source = await loadOwnedSource(actor, id)
  if (source.auto_commit_enabled) {
    throw new AppError('CONFLICT', 'Auto-commit is already enabled.', { reason: 'ALREADY_ENABLED' })
  }
  if (source.pause_reason) {
    throw new AppError('CONFLICT', 'This source is paused. Resume it instead.', { reason: 'SOURCE_PAUSED' })
  }
  if (source.eval_status !== 'passed') {
    throw new AppError('CONFLICT', 'The onboarding evaluation has not passed for this source.', {
      reason: 'EVAL_NOT_PASSED',
    })
  }
  await assertEvaluationCurrent(actor.orgId, id)
  const { error } = await getSupabaseAdmin()
    .from('provider_sources')
    .update({ auto_commit_enabled: true })
    .eq('id', id)
    .eq('org_id', actor.orgId)
  if (error) throw new AppError('INTERNAL', 'Failed to enable auto-commit.', { cause: error })

  await appendAudit({
    orgId: actor.orgId,
    actor: { type: 'user', id: actor.userId },
    event: 'source.auto_commit_enabled',
    payload: { source_id: id, note, flagged_poor: source.flagged_poor },
  })
  return getSource(actor, id)
}

/** Stops auto-commit; every new record is routed to manual review. Idempotent: the first reason is kept. */
export async function pauseSource(actor: AuthUser, id: string, reason: string): Promise<SourceDetail> {
  const source = await loadOwnedSource(actor, id)
  if (!source.pause_reason) {
    const { error } = await getSupabaseAdmin()
      .from('provider_sources')
      .update({ auto_commit_enabled: false, pause_reason: reason })
      .eq('id', id)
      .eq('org_id', actor.orgId)
    if (error) throw new AppError('INTERNAL', 'Failed to pause the source.', { cause: error })
  }
  await appendAudit({
    orgId: actor.orgId,
    actor: { type: 'user', id: actor.userId },
    event: 'source.paused',
    payload: { source_id: id, reason, already_paused: Boolean(source.pause_reason) },
  })
  return getSource(actor, id)
}

/** Re-enables auto-commit after a pause. Blocked while the eval has not passed or an incident is open. */
export async function resumeSource(actor: AuthUser, id: string, note: string): Promise<SourceDetail> {
  const source = await loadOwnedSource(actor, id)
  if (!source.pause_reason) {
    throw new AppError('CONFLICT', 'This source is not paused.', { reason: 'NOT_PAUSED' })
  }
  if (source.eval_status !== 'passed') {
    throw new AppError('CONFLICT', 'The onboarding evaluation has not passed for this source.', {
      reason: 'EVAL_NOT_PASSED',
    })
  }
  await assertEvaluationCurrent(actor.orgId, id)

  const admin = getSupabaseAdmin()
  const { data: incidents, error: incidentError } = await admin
    .from('downstream_errors')
    .select('id, ingestion_records!inner(source_id)')
    .neq('status', 'resolved')
    .eq('ingestion_records.source_id', id)
    .limit(1)
  if (incidentError) throw new AppError('INTERNAL', 'Failed to check open incidents.', { cause: incidentError })
  if ((incidents ?? []).length > 0) {
    throw new AppError('CONFLICT', 'Resolve the open downstream error before resuming.', {
      reason: 'OPEN_INCIDENT',
    })
  }

  const { error } = await admin
    .from('provider_sources')
    .update({ auto_commit_enabled: true, pause_reason: null })
    .eq('id', id)
    .eq('org_id', actor.orgId)
  if (error) throw new AppError('INTERNAL', 'Failed to resume the source.', { cause: error })

  await appendAudit({
    orgId: actor.orgId,
    actor: { type: 'user', id: actor.userId },
    event: 'source.resumed',
    payload: { source_id: id, note },
  })
  return getSource(actor, id)
}

/** Reviewer/admin flag: "this source is consistently poor". Surfaces a warning; does not pause by itself. */
export async function flagSourcePoor(actor: AuthUser, id: string, note: string): Promise<void> {
  await loadOwnedSource(actor, id)
  const admin = getSupabaseAdmin()
  const { error: flagError } = await admin
    .from('source_flags')
    .insert({ source_id: id, flagged_by: actor.userId, note })
  if (flagError) throw new AppError('INTERNAL', 'Failed to record the flag.', { cause: flagError })
  const { error } = await admin
    .from('provider_sources')
    .update({ flagged_poor: true })
    .eq('id', id)
    .eq('org_id', actor.orgId)
  if (error) throw new AppError('INTERNAL', 'Failed to flag the source.', { cause: error })
  await appendAudit({
    orgId: actor.orgId,
    actor: { type: 'user', id: actor.userId },
    event: 'source.updated',
    payload: { source_id: id, fields: ['flagged_poor'] },
  })
}
