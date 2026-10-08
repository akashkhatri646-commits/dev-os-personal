import 'server-only'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { evaluateConsent } from '@/server/services/consent/evaluate'
import type { ConsentArtifact, ConsentQuery, ConsentVerdict } from '@/types/consent'

const artifactSchema = z.object({
  id: z.string(),
  artifact_ref: z.string(),
  categories: z.array(z.string()),
  valid_from: z.string(),
  valid_to: z.string(),
  status: z.enum(['granted', 'revoked', 'expired']),
  created_at: z.string(),
})

/**
 * MVP consent ledger backed by the `consent_artifacts` table, seeded through the admin console.
 * It applies exactly the same matching rules as the real ABDM client will.
 */
export class StubConsentLedger {
  async verify(query: ConsentQuery): Promise<ConsentVerdict> {
    const { data, error } = await getSupabaseAdmin()
      .from('consent_artifacts')
      .select('id, artifact_ref, categories, valid_from, valid_to, status, created_at')
      .eq('patient_id', query.patientId)
      .eq('regime', query.regime)
    if (error) return { result: 'error', matchedScope: [], detail: { reason: 'ledger_query_failed' } }

    const parsed = z.array(artifactSchema).safeParse(data ?? [])
    if (!parsed.success) return { result: 'error', matchedScope: [], detail: { reason: 'malformed_ledger_response' } }

    const artifacts: ConsentArtifact[] = parsed.data
    return evaluateConsent(artifacts, query.requiredCategories, query.at)
  }
}
