import { AI_EXTRACTED_TAG } from '@/server/services/fhir/constants'

export interface ProvenanceRow {
  fhir_resource_id: string
  extraction_method: string
  model_id: string | null
  reviewer_id: string | null
  consent_artifact_id: string | null
  field_provenance: Record<string, { confidence?: number | null; basis?: string | null; reviewer_supplied?: boolean }> | null
  committed_at: string
}

export interface ProvenanceContext {
  resourceType: string
  /** Id of the stored source document, when there is one. */
  documentId: string | null
  /** Reference of the consent artifact the commit relied on, when there is one. */
  consentArtifactRef: string | null
}

const PARTICIPANT_TYPE = 'http://terminology.hl7.org/CodeSystem/provenance-participant-type'

/** Mean model confidence of the fields behind a resource, or null when none is recorded. */
export function meanConfidence(provenance: ProvenanceRow['field_provenance']): number | null {
  const values = Object.values(provenance ?? {})
    .map((entry) => entry.confidence)
    .filter((value): value is number => typeof value === 'number')
  if (values.length === 0) return null
  return Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 1000) / 1000
}

/**
 * A FHIR `Provenance` for a committed resource, built on request from what was stored at commit:
 * the pipeline as the assembling agent, the reviewer as verifier when a person approved it, the
 * source document, the consent that allowed it, and the extraction confidence.
 */
export function buildProvenance(row: ProvenanceRow, context: ProvenanceContext): Record<string, unknown> {
  const agents: Record<string, unknown>[] = [
    {
      type: { coding: [{ system: PARTICIPANT_TYPE, code: 'assembler', display: 'Assembler' }] },
      who: { display: 'AI extraction pipeline', ...(row.model_id ? { identifier: { system: 'urn:health-ingest:model', value: row.model_id } } : {}) },
    },
  ]
  if (row.reviewer_id) {
    agents.push({
      type: { coding: [{ system: PARTICIPANT_TYPE, code: 'verifier', display: 'Verifier' }] },
      who: { reference: `Practitioner/${row.reviewer_id}` },
    })
  }

  const confidence = meanConfidence(row.field_provenance)
  const reviewerSupplied = Object.values(row.field_provenance ?? {}).filter((entry) => entry.reviewer_supplied === true).length
  const extensions: Record<string, unknown>[] = [
    { url: 'urn:health-ingest:extraction-method', valueCode: row.extraction_method },
    ...(confidence !== null ? [{ url: 'urn:health-ingest:extraction-confidence', valueDecimal: confidence }] : []),
    ...(reviewerSupplied > 0 ? [{ url: 'urn:health-ingest:reviewer-supplied-fields', valueInteger: reviewerSupplied }] : []),
  ]

  return {
    resourceType: 'Provenance',
    id: `${row.fhir_resource_id}`,
    meta: { tag: [AI_EXTRACTED_TAG] },
    target: [{ reference: `${context.resourceType}/${row.fhir_resource_id}` }],
    recorded: row.committed_at,
    ...(row.consent_artifact_id ? { policy: [`urn:health-ingest:consent:${context.consentArtifactRef ?? row.consent_artifact_id}`] } : {}),
    agent: agents,
    entity: context.documentId ? [{ role: 'source', what: { reference: `DocumentReference/${context.documentId}` } }] : [],
    extension: extensions,
  }
}
