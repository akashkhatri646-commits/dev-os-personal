import 'server-only'
import { AppError } from '@/lib/api/errors'
import { setStatus } from '@/server/pipeline/orchestrator'
import type { StageContext, StageOutcome } from '@/server/pipeline/stages'
import { sendAlert } from '@/server/services/alerts/alerts'
import { appendAudit } from '@/server/services/audit/auditLog'
import { runConsentCheck } from '@/server/services/consent/runCheck'

/**
 * Component 2: consent-scoped access gating. Runs before any document content is read. A `valid`
 * verdict advances the record; any other verdict is a hard, terminal block with no retry (a new
 * submission is needed once consent is fixed). A ledger `error` retries once, then fails the record
 * (see the worker's handling of a dead consent job), so an outage can never lead to processing.
 */
export async function consentCheckStage({ record }: StageContext): Promise<StageOutcome> {
  if (!record.patient_id) return { kind: 'fail', reason: 'patient_missing' }

  const checked = await runConsentCheck({ ...record, patient_id: record.patient_id })
  if (checked.missingSource) return { kind: 'fail', reason: 'source_missing' }
  const { verdict } = checked

  if (verdict.result === 'valid') return { kind: 'advance' }

  if (verdict.result === 'error') {
    // Retryable: the ledger may recover. After the last attempt the worker fails the record.
    throw new AppError('UPSTREAM_ERROR', 'The consent service could not be reached.', { retryable: true })
  }

  await setStatus(record, 'blocked_consent', { reason: verdict.result })
  await appendAudit({
    orgId: record.org_id,
    recordId: record.id,
    actor: { type: 'system' },
    event: 'consent.blocked',
    payload: { reason: verdict.result, ...(verdict.artifactId ? { artifact_id: verdict.artifactId } : {}) },
  })
  await sendAlert({
    kind: 'consent_blocked',
    message: `Record ${record.id} was blocked: consent ${verdict.result.replaceAll('_', ' ')}.`,
  })
  return { kind: 'finished' }
}
