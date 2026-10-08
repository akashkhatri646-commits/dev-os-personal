import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import type { RecordRow } from '@/server/pipeline/orchestrator'
import { appendAudit } from '@/server/services/audit/auditLog'
import { getConsentService, verifyConsent } from '@/server/services/consent/ConsentService'
import type { ConsentQuery, ConsentRegime, ConsentVerdict } from '@/types/consent'

export type ConsentRunResult = { missingSource: true } | { missingSource: false; verdict: ConsentVerdict }

/**
 * Asks the consent ledger about a record, stores the answer in `consent_checks` and audits it. Used
 * at the start of the pipeline and again before a commit when the stored answer has gone stale.
 * It only records the verdict; what to do about a non-valid one is the caller's decision.
 */
export async function runConsentCheck(record: RecordRow & { patient_id: string }): Promise<ConsentRunResult> {
  const admin = getSupabaseAdmin()
  const { data: source, error: sourceError } = await admin
    .from('provider_sources')
    .select('consent_regime')
    .eq('id', record.source_id)
    .maybeSingle()
  if (sourceError) {
    throw new AppError('INTERNAL', 'Failed to load the source.', { cause: sourceError, retryable: true })
  }
  if (!source) return { missingSource: true }
  const regime = source.consent_regime as ConsentRegime

  const query: ConsentQuery = {
    orgId: record.org_id,
    sourceId: record.source_id,
    patientId: record.patient_id,
    regime,
    requiredCategories: record.data_categories,
    at: new Date(),
  }

  // Selecting an unavailable ledger throws a non-retryable error: the job dies and the record fails.
  const verdict = await verifyConsent(getConsentService(), query)

  const { error: saveError } = await admin.from('consent_checks').upsert(
    {
      record_id: record.id,
      result: verdict.result,
      artifact_id: verdict.artifactId ?? null,
      required_categories: record.data_categories,
      matched_scope: verdict.matchedScope,
      regime,
      detail: verdict.detail,
      checked_at: query.at.toISOString(),
    },
    { onConflict: 'record_id' },
  )
  if (saveError) {
    throw new AppError('INTERNAL', 'Failed to save the consent check.', { cause: saveError, retryable: true })
  }

  await appendAudit({
    orgId: record.org_id,
    recordId: record.id,
    actor: { type: 'system' },
    event: 'consent.checked',
    payload: {
      result: verdict.result,
      required: record.data_categories,
      ...(verdict.artifactId ? { artifact_id: verdict.artifactId } : {}),
    },
  })
  return { missingSource: false, verdict }
}
