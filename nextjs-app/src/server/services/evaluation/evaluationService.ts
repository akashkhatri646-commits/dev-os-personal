import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getEnv } from '@/server/config/env'
import { appendAudit } from '@/server/services/audit/auditLog'
import { computeEvaluation } from '@/server/services/evaluation/compute'
import { loadEvaluationInputs } from '@/server/services/evaluation/load'
import type { AuthUser } from '@/types/domain'
import type { EvalBar, EvalBasis, EvalReport, EvaluationView } from '@/types/evaluation'

interface SourceState {
  id: string
  eval_status: 'none' | 'passed' | 'failed'
  auto_commit_enabled: boolean
}

export function evalBarFromEnv(): EvalBar {
  const env = getEnv()
  return {
    minRecords: env.EVAL_MIN_RECORDS,
    minFields: env.EVAL_MIN_FIELDS,
    targetHighRisk: env.EVAL_TARGET_ACCURACY,
    targetOther: env.EVAL_TARGET_ACCURACY_OTHER,
    targetCode: env.EVAL_TARGET_CODE_ACCURACY,
    minResourcesAtThreshold: env.EVAL_MIN_RESOURCES_AT_THRESHOLD,
  }
}

async function loadSource(orgId: string, sourceId: string): Promise<SourceState> {
  const { data, error } = await getSupabaseAdmin()
    .from('provider_sources')
    .select('id, eval_status, auto_commit_enabled')
    .eq('id', sourceId)
    .eq('org_id', orgId)
    .maybeSingle()
  if (error) throw new AppError('INTERNAL', 'Failed to load the source.', { cause: error })
  if (!data) throw new AppError('NOT_FOUND', 'Source not found.')
  return data as SourceState
}

interface RunRow {
  ran_at: string
  passed: boolean
  basis: EvalBasis | null
  sample_count: number
  prompt_set: { model_id?: string | null } | null
}

async function lastRun(sourceId: string, passedOnly = false): Promise<RunRow | null> {
  let query = getSupabaseAdmin()
    .from('eval_runs')
    .select('ran_at, passed, basis, sample_count, prompt_set')
    .eq('source_id', sourceId)
    .eq('kind', 'source_onboarding')
    .order('ran_at', { ascending: false })
    .limit(1)
  if (passedOnly) query = query.eq('passed', true)
  const { data, error } = await query.maybeSingle()
  if (error) throw new AppError('INTERNAL', 'Failed to load the last evaluation.', { cause: error })
  return (data as RunRow | null) ?? null
}

/** A pass covers the model that produced the reviewed records: a different model now means the pass no longer applies. */
function isStale(source: SourceState, passedRun: RunRow | null): boolean {
  const covered = passedRun?.prompt_set?.model_id ?? null
  const current = getEnv().LLM_MODEL_EXTRACTION ?? null
  return source.eval_status === 'passed' && covered !== null && current !== null && covered !== current
}

function periodStart(days: number | null): string | null {
  return days === null ? null : new Date(Date.now() - days * 86_400_000).toISOString()
}

async function buildView(source: SourceState, sourceId: string, report: EvalReport): Promise<EvaluationView> {
  const [latest, passed] = await Promise.all([lastRun(sourceId), source.eval_status === 'passed' ? lastRun(sourceId, true) : Promise.resolve(null)])
  return {
    ...report,
    model_id: getEnv().LLM_MODEL_EXTRACTION ?? null,
    stale: isStale(source, passed),
    last_run: latest ? { ran_at: latest.ran_at, passed: latest.passed, basis: latest.basis, records: latest.sample_count } : null,
  }
}

/** The live evaluation of a source from its reviewers' decisions. Changes nothing. */
export async function getEvaluation(actor: AuthUser, sourceId: string, days: number | null): Promise<EvaluationView> {
  const source = await loadSource(actor.orgId, sourceId)
  const { fields, records } = await loadEvaluationInputs(sourceId, periodStart(days))
  const report = computeEvaluation({ fields, records, bar: evalBarFromEnv(), periodDays: days })
  return buildView(source, sourceId, report)
}

/**
 * Judges the source on every reviewed record, stores the run, and sets the source's evaluation status. A pass is
 * the only thing that lets auto-commit be enabled. Below the evidence minimums nothing is stored and the answer is
 * a 409 naming what is missing.
 */
export async function runEvaluation(actor: AuthUser, sourceId: string, input: { basis: EvalBasis; note?: string }): Promise<EvaluationView> {
  if (actor.role !== 'admin') throw new AppError('FORBIDDEN', 'Only an admin can run an evaluation.')
  const source = await loadSource(actor.orgId, sourceId)

  const { fields, records } = await loadEvaluationInputs(sourceId, null)
  const report = computeEvaluation({ fields, records, bar: evalBarFromEnv(), periodDays: null })
  if (report.verdict === 'insufficient_evidence') {
    throw new AppError('CONFLICT', 'There are not enough reviewed records or fields yet to judge this source.', {
      reason: 'INSUFFICIENT_EVIDENCE',
      details: { criteria: report.criteria.filter((entry) => entry.met === false) },
    })
  }
  const passed = report.verdict === 'passed'

  const admin = getSupabaseAdmin()
  const { data: thresholds, error: thresholdError } = await admin.from('routing_thresholds').select('resource_type, threshold').eq('source_id', sourceId).eq('active', true)
  if (thresholdError) throw new AppError('INTERNAL', 'Failed to read the thresholds.', { cause: thresholdError })

  const { error: runError } = await admin.from('eval_runs').insert({
    org_id: actor.orgId,
    kind: 'source_onboarding',
    source_id: sourceId,
    prompt_set: { model_id: getEnv().LLM_MODEL_EXTRACTION ?? null, thresholds: Object.fromEntries((thresholds ?? []).map((row) => [row.resource_type as string, Number(row.threshold)])) },
    metrics: report,
    passed,
    sample_count: report.evidence.records,
    basis: input.basis,
  })
  if (runError) throw new AppError('INTERNAL', 'Failed to store the evaluation.', { cause: runError })

  // A failed evaluation also switches auto-commit off: the database allows it only while the evaluation has passed.
  const update = passed
    ? { eval_status: 'passed', eval_passed_at: new Date().toISOString(), eval_basis: input.basis }
    : { eval_status: 'failed', eval_passed_at: null, eval_basis: null, auto_commit_enabled: false }
  const { error: updateError } = await admin.from('provider_sources').update(update).eq('id', sourceId).eq('org_id', actor.orgId)
  if (updateError) throw new AppError('INTERNAL', 'Failed to update the source.', { cause: updateError })

  await appendAudit({
    orgId: actor.orgId,
    actor: { type: 'user', id: actor.userId },
    event: 'source.eval_run',
    payload: {
      source_id: sourceId,
      verdict: report.verdict,
      basis: input.basis,
      records: report.evidence.records,
      fields: report.evidence.fields,
      auto_commit_switched_off: !passed && source.auto_commit_enabled,
      ...(input.note ? { note: input.note } : {}),
    },
  })

  return buildView({ ...source, eval_status: passed ? 'passed' : 'failed' }, sourceId, report)
}

/**
 * Clears a pass when what it covered has changed (thresholds). Auto-commit is switched off in the same update because
 * the database allows it only while the evaluation has passed. Does nothing when there is no pass to clear.
 */
export async function resetEvaluation(params: { orgId: string; sourceId: string; actorId: string | null; reason: string }): Promise<void> {
  const source = await loadSource(params.orgId, params.sourceId)
  if (source.eval_status === 'none') return
  const { error } = await getSupabaseAdmin()
    .from('provider_sources')
    .update({ eval_status: 'none', eval_passed_at: null, eval_basis: null, auto_commit_enabled: false })
    .eq('id', params.sourceId)
    .eq('org_id', params.orgId)
  if (error) throw new AppError('INTERNAL', 'Failed to reset the evaluation.', { cause: error })
  await appendAudit({
    orgId: params.orgId,
    actor: params.actorId ? { type: 'user', id: params.actorId } : { type: 'system' },
    event: 'source.eval_reset',
    payload: { source_id: params.sourceId, reason: params.reason, previous_status: source.eval_status, auto_commit_was_enabled: source.auto_commit_enabled },
  })
}

/** Refuses to enable or resume auto-commit when the passed evaluation covered a different model than the one in use. */
export async function assertEvaluationCurrent(orgId: string, sourceId: string): Promise<void> {
  const source = await loadSource(orgId, sourceId)
  if (source.eval_status !== 'passed') return
  if (isStale(source, await lastRun(sourceId, true))) {
    throw new AppError('CONFLICT', 'The evaluation passed for a different model. Review records with the current model and run the evaluation again.', {
      reason: 'EVAL_STALE',
    })
  }
}
