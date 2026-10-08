import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { buildProvenance, type ProvenanceRow } from '@/server/services/fhir/provenance'
import { RESOURCE_TYPES, type AuthUser, type ResourceType } from '@/types/domain'

export const FHIR_CONTENT_TYPE = 'application/fhir+json'

const MAX_COUNT = 100

const resourceRowSchema = z.object({
  id: z.string(),
  record_id: z.string(),
  patient_id: z.string(),
  resource_type: z.string(),
  resource: z.record(z.string(), z.unknown()),
  version_id: z.number(),
  updated_at: z.string(),
})
type FhirRow = z.infer<typeof resourceRowSchema>

const COLUMNS = 'id, record_id, patient_id, resource_type, resource, version_id, updated_at'

const provenanceRowSchema = z.object({
  fhir_resource_id: z.string(),
  record_id: z.string(),
  consent_artifact_id: z.string().nullable(),
  extraction_method: z.string(),
  model_id: z.string().nullable(),
  reviewer_id: z.string().nullable(),
  field_provenance: z.record(z.string(), z.object({ confidence: z.number().nullable().optional(), basis: z.string().nullable().optional(), reviewer_supplied: z.boolean().optional() }).passthrough()).nullable(),
  committed_at: z.string(),
})

export function parseResourceType(value: string): ResourceType {
  const type = RESOURCE_TYPES.find((candidate) => candidate === value)
  if (!type) throw new AppError('NOT_FOUND', `Resource type ${value} is not supported.`)
  return type
}

/** The stored resource with the version and time of its last change, as a FHIR server would return it. */
function present(row: FhirRow): Record<string, unknown> {
  const meta = (row.resource.meta ?? {}) as Record<string, unknown>
  return { ...row.resource, id: row.id, meta: { ...meta, versionId: String(row.version_id), lastUpdated: row.updated_at } }
}

function fail(message: string, cause: unknown): never {
  throw new AppError('INTERNAL', message, { cause })
}

async function loadRow(actor: AuthUser, type: ResourceType, id: string): Promise<FhirRow> {
  const { data, error } = await getSupabaseAdmin().from('fhir_resources').select(COLUMNS).eq('id', id).eq('org_id', actor.orgId).eq('resource_type', type).maybeSingle()
  if (error) fail('Failed to read the resource.', error)
  if (!data) throw new AppError('NOT_FOUND', 'Resource not found.')
  return resourceRowSchema.parse(data)
}

async function provenanceFor(actor: AuthUser, row: FhirRow): Promise<Record<string, unknown>> {
  const admin = getSupabaseAdmin()
  const { data, error } = await admin
    .from('provenance')
    .select('fhir_resource_id, record_id, consent_artifact_id, extraction_method, model_id, reviewer_id, field_provenance, committed_at')
    .eq('fhir_resource_id', row.id)
    .maybeSingle()
  if (error) fail('Failed to read the provenance.', error)
  if (!data) throw new AppError('NOT_FOUND', 'Provenance not found.')
  const provenance = provenanceRowSchema.parse(data)

  const [document, artifact] = await Promise.all([
    admin.from('documents').select('id').eq('record_id', provenance.record_id).limit(1).maybeSingle(),
    provenance.consent_artifact_id
      ? admin.from('consent_artifacts').select('artifact_ref').eq('id', provenance.consent_artifact_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  if (document.error) fail('Failed to read the document.', document.error)
  if (artifact.error) fail('Failed to read the consent reference.', artifact.error)

  return buildProvenance(provenance as ProvenanceRow, {
    resourceType: row.resource_type,
    documentId: (document.data?.id as string | undefined) ?? null,
    consentArtifactRef: (artifact.data?.artifact_ref as string | undefined) ?? null,
  })
}

export async function readFhirResource(actor: AuthUser, type: ResourceType, id: string): Promise<Record<string, unknown>> {
  return present(await loadRow(actor, type, id))
}

/** A search-set bundle holding the resource and, with `_include=Provenance`, its provenance. */
export async function readFhirWithProvenance(actor: AuthUser, type: ResourceType, id: string): Promise<Record<string, unknown>> {
  const row = await loadRow(actor, type, id)
  const provenance = await provenanceFor(actor, row)
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    total: 1,
    entry: [
      { fullUrl: `${type}/${id}`, resource: present(row), search: { mode: 'match' } },
      { fullUrl: `Provenance/${id}`, resource: provenance, search: { mode: 'include' } },
    ],
  }
}

export async function readFhirProvenance(actor: AuthUser, id: string): Promise<Record<string, unknown>> {
  const { data, error } = await getSupabaseAdmin().from('fhir_resources').select(COLUMNS).eq('id', id).eq('org_id', actor.orgId).maybeSingle()
  if (error) fail('Failed to read the resource.', error)
  if (!data) throw new AppError('NOT_FOUND', 'Provenance not found.')
  return provenanceFor(actor, resourceRowSchema.parse(data))
}

export interface FhirSearch {
  patient?: string
  record?: string
  count: number
  page: number
}

export async function searchFhirResources(actor: AuthUser, type: ResourceType, search: FhirSearch): Promise<Record<string, unknown>> {
  const count = Math.min(search.count, MAX_COUNT)
  const from = (search.page - 1) * count
  let query = getSupabaseAdmin()
    .from('fhir_resources')
    .select(COLUMNS, { count: 'exact' })
    .eq('org_id', actor.orgId)
    .eq('resource_type', type)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, from + count - 1)
  if (search.patient) query = query.eq('patient_id', search.patient)
  if (search.record) query = query.eq('record_id', search.record)
  const { data, count: total, error } = await query
  if (error) fail('Failed to search resources.', error)

  const rows = z.array(resourceRowSchema).parse(data ?? [])
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    total: total ?? rows.length,
    entry: rows.map((row) => ({ fullUrl: `${type}/${row.id}`, resource: present(row), search: { mode: 'match' } })),
  }
}

/** Wraps a FHIR body as a response with the FHIR media type. */
export function fhirResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': `${FHIR_CONTENT_TYPE}; charset=utf-8` } })
}
