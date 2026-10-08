import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import type { StageContext, StageOutcome } from '@/server/pipeline/stages'
import { appendAudit } from '@/server/services/audit/auditLog'
import { assertConsentValid } from '@/server/services/consent/ConsentService'
import type { FhirResource } from '@/server/services/fhir/builders'
import { getFhirValidator } from '@/server/services/fhir/validator'
import { SupabaseTerminologySearch } from '@/server/services/terminology/search'
import type { CodeSystem } from '@/types/domain'

const rowSchema = z.object({ id: z.string(), resource: z.record(z.string(), z.unknown()), profile_url: z.string().nullable() })

const SYSTEM_BY_URI: Record<string, CodeSystem> = {
  'http://snomed.info/sct': 'snomed',
  'http://loinc.org': 'loinc',
  'http://hl7.org/fhir/sid/icd-10': 'icd10',
}

/**
 * Component 4b: checks every mapped resource against the structural rules and stores the result.
 * Resources are never changed here. A failed resource does not stop the pipeline: it carries its
 * issues forward and scoring and routing send the record to review.
 */
export async function validateStage({ record }: StageContext): Promise<StageOutcome> {
  await assertConsentValid(record.id)

  const admin = getSupabaseAdmin()
  const { data, error } = await admin.from('mapped_resources').select('id, resource, profile_url').eq('record_id', record.id)
  if (error) throw new AppError('INTERNAL', 'Failed to load the mapped resources.', { cause: error, retryable: true })
  const rows = z.array(rowSchema).parse(data ?? [])
  if (rows.length === 0) return { kind: 'escalate', reason: 'no_data_extracted' }
  if (!record.patient_id) return { kind: 'fail', reason: 'patient_missing' }

  const resources = rows.map((row) => row.resource as FhirResource)
  const search = new SupabaseTerminologySearch()
  const results = await getFhirValidator().validate(resources, {
    patientId: record.patient_id,
    resourceIds: new Set(rows.map((row) => row.id)),
    now: new Date(),
    isKnownCode: (uri, code) => {
      const system = SYSTEM_BY_URI[uri]
      return system ? search.exists(system, code) : Promise.resolve(true)
    },
  })

  for (const result of results) {
    const { error: updateError } = await admin
      .from('mapped_resources')
      .update({ validation_status: result.status, validation_issues: result.issues })
      .eq('id', result.resourceId)
    if (updateError) throw new AppError('INTERNAL', 'Failed to save the validation result.', { cause: updateError, retryable: true })
  }

  const failed = results.filter((result) => result.status === 'fail')
  await appendAudit({
    orgId: record.org_id,
    recordId: record.id,
    actor: { type: 'system' },
    event: 'validation.completed',
    payload: {
      resources: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      issues: results.reduce((total, result) => total + result.issues.length, 0),
    },
  })
  return { kind: 'advance' }
}
