import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { loadRecord } from '@/server/pipeline/orchestrator'
import { loadWorkspaceData, resourcesOf } from '@/server/services/review/recordData'
import { visibleDecision } from '@/server/services/review/workspace'
import type { AuthUser } from '@/types/domain'
import type { ProvenanceView, RecordFhirResource, RecordTrace } from '@/types/trace'

const COMMITTED = ['auto_committed', 'committed']

function fail(message: string, cause: unknown): never {
  throw new AppError('INTERNAL', message, { cause })
}

const provenanceSchema = z.object({
  fhir_resource_id: z.string(),
  extraction_method: z.string(),
  model_id: z.string().nullable(),
  prompt_set: z.record(z.string(), z.unknown()).nullable(),
  reviewer_id: z.string().nullable(),
  consent_artifact_id: z.string().nullable(),
  field_provenance: z.record(z.string(), z.unknown()).nullable(),
  committed_at: z.string(),
})

/** The prompt versions recorded on the record, as readable `{component: id}` pairs. */
export function promptVersionsOf(promptSet: Record<string, unknown> | null | undefined): Record<string, string> {
  const versions = promptSet?.prompt_versions
  if (typeof versions !== 'object' || versions === null) return {}
  return Object.fromEntries(Object.entries(versions).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/**
 * Fields, FHIR resources (committed ones once the record is committed, drafts before), the routing
 * decision and provenance for one record. Anyone allowed to open the record page may read it; the
 * audit-sample reason stays hidden from everyone but admins.
 */
export async function getRecordTrace(actor: AuthUser, id: string): Promise<RecordTrace> {
  const record = await loadRecord(id)
  if (!record || record.org_id !== actor.orgId) throw new AppError('NOT_FOUND', 'Record not found.')

  const admin = getSupabaseAdmin()
  const data = await loadWorkspaceData(record)
  const committed = COMMITTED.includes(record.status)

  const [fhir, provenance] = await Promise.all([
    committed ? admin.from('fhir_resources').select('id, resource_type, resource, version_id').eq('record_id', id) : Promise.resolve({ data: null, error: null }),
    committed ? admin.from('provenance').select('fhir_resource_id, extraction_method, model_id, prompt_set, reviewer_id, consent_artifact_id, field_provenance, committed_at').eq('record_id', id) : Promise.resolve({ data: [], error: null }),
  ])
  if (fhir.error) fail('Failed to load the FHIR resources.', fhir.error)
  if (provenance.error) fail('Failed to load the provenance.', provenance.error)

  const resources: RecordFhirResource[] = committed
    ? z
        .array(z.object({ id: z.string(), resource_type: z.string(), resource: z.record(z.string(), z.unknown()), version_id: z.number() }))
        .parse(fhir.data ?? [])
        .map((row) => ({ id: row.id, resource_type: row.resource_type, committed: true, version_id: row.version_id, resource: row.resource }))
    : (await admin.from('mapped_resources').select('id, resource_type, resource').eq('record_id', id)).data?.map((row) => ({
        id: row.id as string,
        resource_type: row.resource_type as string,
        committed: false,
        version_id: null,
        resource: row.resource as Record<string, unknown>,
      })) ?? []

  const rows = z.array(provenanceSchema).parse(provenance.data ?? [])
  const reviewerIds = [...new Set(rows.map((row) => row.reviewer_id).filter((value): value is string => value !== null))]
  const artifactIds = [...new Set(rows.map((row) => row.consent_artifact_id).filter((value): value is string => value !== null))]
  const [reviewers, artifacts] = await Promise.all([
    reviewerIds.length > 0 ? admin.from('profiles').select('id, full_name, email').in('id', reviewerIds) : Promise.resolve({ data: [], error: null }),
    artifactIds.length > 0 ? admin.from('consent_artifacts').select('id, artifact_ref').in('id', artifactIds) : Promise.resolve({ data: [], error: null }),
  ])
  if (reviewers.error) fail('Failed to load reviewers.', reviewers.error)
  if (artifacts.error) fail('Failed to load consent references.', artifacts.error)
  const reviewerName = new Map((reviewers.data ?? []).map((row) => [row.id as string, ((row.full_name as string | null) ?? (row.email as string))]))
  const artifactRef = new Map((artifacts.data ?? []).map((row) => [row.id as string, row.artifact_ref as string]))
  const typeById = new Map(resources.map((resource) => [resource.id, resource.resource_type]))

  const provenanceViews: ProvenanceView[] = rows.map((row) => ({
    resource_id: row.fhir_resource_id,
    resource_type: typeById.get(row.fhir_resource_id) ?? 'Resource',
    extraction_method: row.extraction_method,
    model_id: row.model_id,
    prompt_versions: promptVersionsOf(row.prompt_set),
    reviewer_name: row.reviewer_id ? (reviewerName.get(row.reviewer_id) ?? 'Reviewer') : null,
    consent_artifact_ref: row.consent_artifact_id ? (artifactRef.get(row.consent_artifact_id) ?? null) : null,
    committed_at: row.committed_at,
    field_count: Object.keys(row.field_provenance ?? {}).length,
  }))

  const shown = data.decision
    ? visibleDecision({ reasons: data.decision.escalation_reasons, reasoning_trace: data.decision.reasoning_trace }, data.decision.escalation_reasons.includes('holdback') ? 'holdback_audit' : 'escalation', actor.role === 'admin')
    : null
  return {
    resources: resourcesOf(record, data),
    fhir: resources,
    decision:
      data.decision && shown
        ? {
            aggregate_score: data.decision.aggregate_score,
            reasons: shown.reasons,
            reasoning_trace: shown.reasoning_trace,
            thresholds_applied: Object.fromEntries(Object.entries(data.decision.thresholds_applied).filter(([key]) => key !== '_checksum')) as NonNullable<RecordTrace['decision']>['thresholds_applied'],
          }
        : null,
    provenance: provenanceViews,
  }
}
