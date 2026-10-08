import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getRuntimeConfig } from '@/server/config/constants'
import { setStatus } from '@/server/pipeline/orchestrator'
import type { StageContext, StageOutcome } from '@/server/pipeline/stages'
import { sendAlert } from '@/server/services/alerts/alerts'
import { appendAudit } from '@/server/services/audit/auditLog'
import { ALREADY_COMMITTED, commitErrorCode, commitErrorToAppError } from '@/server/services/commit/commitErrors'
import { assertConsentValid } from '@/server/services/consent/ConsentService'
import { runConsentCheck } from '@/server/services/consent/runCheck'
import { thresholdsChecksum, type AppliedThreshold } from '@/server/services/routing/decide'

/** A consent answer older than this is asked again before anything is committed (spec 05 §6). */
export const CONSENT_RECHECK_AFTER_MS = 24 * 60 * 60 * 1000

function fail(message: string, cause: unknown): never {
  throw new AppError('INTERNAL', message, { cause, retryable: true })
}

/** True when the stored routing decision is an auto-commit whose thresholds are unchanged since it was made. */
function decisionIntact(row: { decision: string; thresholds_applied: unknown } | null): boolean {
  if (!row || row.decision !== 'auto_commit') return false
  const { _checksum: checksum, ...applied } = (row.thresholds_applied ?? {}) as Record<string, unknown>
  return typeof checksum === 'string' && checksum === thresholdsChecksum(applied as Record<string, AppliedThreshold>)
}

/**
 * Component 8: commit. Re-checks what could have changed since routing (consent that has gone stale,
 * the source's auto-commit switch, the stored decision), then calls `commit_record`, which writes
 * the resources, their provenance, the record status and the audit event in one transaction.
 * Committing twice is harmless: a repeat finds the record already committed.
 */
export async function commitStage({ record }: StageContext): Promise<StageOutcome> {
  await assertConsentValid(record.id)
  const admin = getSupabaseAdmin()

  const { data: check, error: checkError } = await admin.from('consent_checks').select('checked_at').eq('record_id', record.id).maybeSingle()
  if (checkError) fail('Failed to read the consent check.', checkError)
  const stale = !check?.checked_at || Date.now() - Date.parse(check.checked_at as string) > CONSENT_RECHECK_AFTER_MS
  if (stale) {
    if (!record.patient_id) return { kind: 'fail', reason: 'patient_missing' }
    const checked = await runConsentCheck({ ...record, patient_id: record.patient_id })
    if (checked.missingSource) return { kind: 'fail', reason: 'source_missing' }
    if (checked.verdict.result === 'error') throw new AppError('UPSTREAM_ERROR', 'The consent service could not be reached.', { retryable: true })
    if (checked.verdict.result !== 'valid') {
      await setStatus(record, 'blocked_consent', { reason: checked.verdict.result })
      await appendAudit({ orgId: record.org_id, recordId: record.id, actor: { type: 'system' }, event: 'consent.blocked', payload: { reason: checked.verdict.result } })
      await sendAlert({ kind: 'consent_blocked', message: `Record ${record.id} was blocked before commit: consent ${checked.verdict.result.replaceAll('_', ' ')}.` })
      return { kind: 'finished' }
    }
  }

  const [source, decision] = await Promise.all([
    admin.from('provider_sources').select('auto_commit_enabled').eq('id', record.source_id).maybeSingle(),
    admin.from('routing_decisions').select('decision, thresholds_applied').eq('record_id', record.id).maybeSingle(),
  ])
  if (source.error) fail('Failed to load the source.', source.error)
  if (decision.error) fail('Failed to load the routing decision.', decision.error)

  if (!source.data?.auto_commit_enabled || !getRuntimeConfig().systemAutoCommitEnabled) {
    return { kind: 'escalate', reason: 'source_paused' }
  }
  if (!decisionIntact(decision.data)) {
    await sendAlert({ kind: 'commit_failed', message: `Record ${record.id}: the stored routing decision did not verify, so it was not committed.` })
    return { kind: 'escalate', reason: 'stage_error:commit' }
  }

  const { error } = await admin.rpc('commit_record', { p_record_id: record.id, p_mode: 'auto', p_reviewer_id: null as unknown as string })
  if (!error) return { kind: 'finished' }

  if (commitErrorCode(error.message) === ALREADY_COMMITTED) {
    const { count, error: countError } = await admin.from('fhir_resources').select('id', { count: 'exact', head: true }).eq('record_id', record.id)
    if (countError) fail('Failed to verify the committed resources.', countError)
    if ((count ?? 0) > 0) return { kind: 'finished' }
  }
  const appError = commitErrorToAppError(error)
  if (!appError.retryable) {
    await sendAlert({ kind: 'commit_failed', message: `Record ${record.id} could not be committed (${appError.reason ?? 'refused'}).` })
  }
  throw appError
}
