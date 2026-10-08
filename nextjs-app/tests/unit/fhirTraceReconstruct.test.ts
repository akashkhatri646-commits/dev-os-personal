import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks, state } = vi.hoisted(() => ({
  mocks: { loadRecord: vi.fn(), appendAudit: vi.fn(), range: vi.fn(), rpc: vi.fn() },
  state: { tables: {} as Record<string, { single?: unknown; list?: unknown[]; count?: number }> },
}))

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      const entry = () => state.tables[table] ?? {}
      const query: Record<string, unknown> = {}
      for (const method of ['eq', 'in', 'order', 'limit', 'select']) query[method] = () => query
      query.range = (from: number, to: number) => {
        mocks.range(from, to)
        return query
      }
      query.maybeSingle = () => Promise.resolve({ data: entry().single ?? null, error: null })
      query.then = (resolve: (value: unknown) => unknown) => resolve({ data: entry().list ?? [], count: entry().count ?? (entry().list ?? []).length, error: null })
      return { select: () => query }
    },
  }),
}))
vi.mock('@/server/pipeline/orchestrator', () => ({ loadRecord: mocks.loadRecord }))
vi.mock('@/server/services/audit/auditLog', () => ({ appendAudit: mocks.appendAudit, appendAuditBestEffort: mocks.appendAudit }))
vi.mock('@/server/services/audit/auditQuery', async () => {
  const { z } = await import('zod')
  return {
    COLUMNS: 'id',
    rowSchema: z.object({
      id: z.number(),
      created_at: z.string(),
      actor_type: z.enum(['user', 'system', 'api_key']),
      actor_id: z.string().nullable(),
      event: z.string(),
      record_id: z.string().nullable(),
      payload: z.record(z.string(), z.unknown()),
      hash: z.string(),
      prev_hash: z.string().nullable(),
    }),
    hashChecks: async (_org: string, ids: number[]) => new Map(ids.map((id) => [id, id !== 3])),
    actorNames: async () => new Map([['rev-1', 'Rita Reviewer']]),
  }
})

import { fhirReadQuerySchema, fhirSearchQuerySchema } from '@/lib/validation/fhir'
import { reconstructRecord } from '@/server/services/audit/reconstruct'
import { parseResourceType, readFhirProvenance, readFhirResource, readFhirWithProvenance, searchFhirResources } from '@/server/services/fhir/fhirRead'
import { buildProvenance, meanConfidence } from '@/server/services/fhir/provenance'
import { getRecordTrace } from '@/server/services/records/traceService'
import type { AuthUser } from '@/types/domain'

const admin: AuthUser = { userId: 'adm-1', email: null, orgId: 'org-1', orgName: null, fullName: null, role: 'admin' }
const engineer: AuthUser = { ...admin, userId: 'ie-1', role: 'integration_engineer' }

const resourceRow = {
  id: 'res-1',
  record_id: 'rec-1',
  patient_id: 'pat-1',
  resource_type: 'MedicationRequest',
  resource: { resourceType: 'MedicationRequest', id: 'res-1', meta: { tag: [{ code: 'ai-extracted' }] } },
  version_id: 2,
  updated_at: '2026-10-07T10:00:00Z',
}
const provenanceRow = {
  fhir_resource_id: 'res-1',
  record_id: 'rec-1',
  consent_artifact_id: 'art-1',
  extraction_method: 'ai_extracted_human_reviewed',
  model_id: 'model-x',
  prompt_set: { prompt_versions: { extraction: 'pv-1' } },
  reviewer_id: 'rev-1',
  field_provenance: { 'medication[0].name': { confidence: 0.9 }, 'medication[0].dose_value': { confidence: 0.8, reviewer_supplied: true } },
  committed_at: '2026-10-07T10:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  state.tables = {
    fhir_resources: { single: resourceRow, list: [resourceRow], count: 41 },
    provenance: { single: provenanceRow, list: [provenanceRow] },
    documents: { single: { id: 'doc-1', ocr_engine: 'textract', ocr_confidence: 0.97, page_count: 2 } },
    consent_artifacts: { single: { artifact_ref: 'ABDM-1' }, list: [{ id: 'art-1', artifact_ref: 'ABDM-1' }] },
  }
})

describe('buildProvenance', () => {
  const context = { resourceType: 'MedicationRequest', documentId: 'doc-1', consentArtifactRef: 'ABDM-1' }

  it('names the pipeline as assembler and the reviewer as verifier', () => {
    const human = buildProvenance(provenanceRow, context) as Record<string, any>
    expect(human.resourceType).toBe('Provenance')
    expect(human.target).toEqual([{ reference: 'MedicationRequest/res-1' }])
    expect(human.agent).toHaveLength(2)
    expect(human.agent[1].who).toEqual({ reference: 'Practitioner/rev-1' })
    expect(JSON.stringify(human.meta)).toContain('ai-extracted')

    const auto = buildProvenance({ ...provenanceRow, reviewer_id: null, extraction_method: 'ai_extracted_auto' }, context) as Record<string, any>
    expect(auto.agent).toHaveLength(1)
  })

  it('links the source document and the consent, and records confidence and reviewer-supplied fields', () => {
    const provenance = buildProvenance(provenanceRow, context) as Record<string, any>
    expect(provenance.entity).toEqual([{ role: 'source', what: { reference: 'DocumentReference/doc-1' } }])
    expect(provenance.policy).toEqual(['urn:health-ingest:consent:ABDM-1'])
    const byUrl = Object.fromEntries(provenance.extension.map((entry: { url: string }) => [entry.url, entry]))
    expect(byUrl['urn:health-ingest:extraction-confidence'].valueDecimal).toBe(0.85)
    expect(byUrl['urn:health-ingest:reviewer-supplied-fields'].valueInteger).toBe(1)
  })

  it('leaves out what is not recorded', () => {
    const bare = buildProvenance({ ...provenanceRow, consent_artifact_id: null, field_provenance: null, reviewer_id: null }, { ...context, documentId: null }) as Record<string, any>
    expect(bare.policy).toBeUndefined()
    expect(bare.entity).toEqual([])
    expect(meanConfidence(null)).toBeNull()
  })
})

describe('FHIR read', () => {
  it('accepts supported resource types and rejects others with 404', () => {
    expect(parseResourceType('MedicationRequest')).toBe('MedicationRequest')
    expect(() => parseResourceType('Patient')).toThrowError(/not supported/)
  })

  it('returns the resource with its version and last-change time', async () => {
    const resource = (await readFhirResource(admin, 'MedicationRequest', 'res-1')) as Record<string, any>
    expect(resource.meta).toMatchObject({ versionId: '2', lastUpdated: '2026-10-07T10:00:00Z' })
    expect(JSON.stringify(resource.meta)).toContain('ai-extracted')
  })

  it('answers 404 when the resource is not in the caller organisation or of that type', async () => {
    state.tables.fhir_resources = { single: undefined as never }
    await expect(readFhirResource(admin, 'MedicationRequest', 'res-1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(readFhirProvenance(admin, 'res-1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns a bundle with the resource and its provenance for _include=Provenance', async () => {
    const bundle = (await readFhirWithProvenance(engineer, 'MedicationRequest', 'res-1')) as Record<string, any>
    expect(bundle).toMatchObject({ resourceType: 'Bundle', type: 'searchset', total: 1 })
    expect(bundle.entry.map((entry: { search: { mode: string } }) => entry.search.mode)).toEqual(['match', 'include'])
    expect(bundle.entry[1].resource.resourceType).toBe('Provenance')
    expect(bundle.entry[1].resource.policy).toEqual(['urn:health-ingest:consent:ABDM-1'])
  })

  it('searches with paging and reports the total', async () => {
    const bundle = (await searchFhirResources(engineer, 'MedicationRequest', { patient: 'pat-1', count: 10, page: 3 })) as Record<string, any>
    expect(mocks.range).toHaveBeenCalledWith(20, 29)
    expect(bundle.total).toBe(41)
    expect(bundle.entry).toHaveLength(1)
  })

  it('only accepts the supported query parameters', () => {
    expect(fhirSearchQuerySchema.safeParse({ patient: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', _count: '5' }).success).toBe(true)
    expect(fhirSearchQuerySchema.safeParse({ name: 'x' }).success).toBe(false)
    expect(fhirSearchQuerySchema.safeParse({ patient: 'not-a-uuid' }).success).toBe(false)
    expect(fhirReadQuerySchema.safeParse({ _include: 'Provenance' }).success).toBe(true)
    expect(fhirReadQuerySchema.safeParse({ _include: 'Other' }).success).toBe(false)
    expect(fhirReadQuerySchema.safeParse({ _revinclude: 'x' }).success).toBe(false)
  })
})

const baseRecord = {
  id: 'rec-1',
  org_id: 'org-1',
  source_id: 's-1',
  patient_id: 'pat-1',
  doc_type: 'discharge_summary',
  input_kind: 'pdf',
  data_categories: ['DischargeSummary'],
  status: 'committed',
  status_reason: null,
  created_at: '2026-10-07T00:00:00Z',
}

describe('getRecordTrace', () => {
  const seed = (status: string, reasons: string[]) => {
    mocks.loadRecord.mockResolvedValue({ ...baseRecord, status })
    state.tables = {
      ...state.tables,
      provider_sources: { single: { id: 's-1', name: 'City Hospital' } },
      routing_decisions: { single: { aggregate_score: 0.96, escalation_reasons: reasons, reasoning_trace: 'Record aggregate 0.960. Decision: escalate (holdback).', thresholds_applied: { MedicationRequest: { threshold: 0.95, version: 1, score: 0.96, pass: true }, _checksum: 'x' } } },
      mapped_resources: { list: [{ id: 'res-1', resource_type: 'MedicationRequest', source_ref: 'medication[0]', codings: [], flags: [], validation_status: 'pass', validation_issues: [], resource: { resourceType: 'MedicationRequest' } }] },
      extracted_fields: { list: [] },
      field_scores: { list: [] },
      consent_checks: { single: { result: 'valid', checked_at: '2026-10-07T00:00:00Z' } },
      profiles: { list: [{ id: 'rev-1', full_name: 'Rita Reviewer', email: 'r@example.org' }] },
    }
  }

  it('returns committed resources and provenance for a committed record', async () => {
    seed('committed', ['below_threshold'])
    const trace = await getRecordTrace(engineer, 'rec-1')
    expect(trace.fhir).toMatchObject([{ id: 'res-1', committed: true, version_id: 2 }])
    expect(trace.provenance).toMatchObject([{ resource_id: 'res-1', reviewer_name: 'Rita Reviewer', consent_artifact_ref: 'ABDM-1', prompt_versions: { extraction: 'pv-1' }, field_count: 2 }])
    expect(trace.decision?.thresholds_applied).not.toHaveProperty('_checksum')
  })

  it('shows drafts, with no provenance, before commit', async () => {
    seed('needs_review', ['below_threshold'])
    state.tables.mapped_resources = { ...state.tables.mapped_resources, list: [{ id: 'res-1', resource_type: 'MedicationRequest', source_ref: 'medication[0]', codings: [], flags: [], validation_status: 'pass', validation_issues: [], resource: { resourceType: 'MedicationRequest' } }] }
    const trace = await getRecordTrace(engineer, 'rec-1')
    expect(trace.fhir).toMatchObject([{ committed: false, version_id: null }])
    expect(trace.provenance).toEqual([])
  })

  it('hides the audit-sample reason from everyone but admins', async () => {
    seed('needs_review', ['holdback'])
    expect((await getRecordTrace(engineer, 'rec-1')).decision?.reasons).toEqual([])
    expect((await getRecordTrace(admin, 'rec-1')).decision?.reasons).toEqual(['holdback'])
  })

  it('answers 404 for another organisation', async () => {
    mocks.loadRecord.mockResolvedValue({ ...baseRecord, org_id: 'org-2' })
    await expect(getRecordTrace(engineer, 'rec-1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('reconstructRecord', () => {
  const seed = () => {
    state.tables = {
      ingestion_records: { single: { id: 'rec-1', status: 'committed', status_reason: null, doc_type: 'discharge_summary', input_kind: 'pdf', source_id: 's-1', created_at: '2026-10-07T00:00:00Z', completed_at: '2026-10-07T00:05:00Z', cost_usd: '0.0420', latency_ms: 300000, holdback: false, prompt_set: { model_id: 'model-x', prompt_versions: { extraction: 'pv-1' }, injection_suspected: false } } },
      provider_sources: { single: { id: 's-1', name: 'City Hospital' } },
      documents: { single: { id: 'doc-1', ocr_engine: 'textract', ocr_confidence: '0.970', page_count: 2 } },
      consent_checks: { single: { result: 'valid', regime: 'abdm', required_categories: ['DischargeSummary'], matched_scope: ['DischargeSummary'], checked_at: '2026-10-07T00:00:01Z', artifact_id: 'art-1' } },
      consent_artifacts: { single: { artifact_ref: 'ABDM-1' } },
      audit_log: {
        list: [
          { id: 1, created_at: '2026-10-07T00:00:01Z', actor_type: 'system', actor_id: null, event: 'consent.checked', record_id: 'rec-1', payload: { result: 'valid' }, hash: 'a'.repeat(64), prev_hash: null },
          { id: 2, created_at: '2026-10-07T00:01:00Z', actor_type: 'system', actor_id: null, event: 'extraction.completed', record_id: 'rec-1', payload: { fields_found: 12, fields_not_found: 3 }, hash: 'b'.repeat(64), prev_hash: 'a'.repeat(64) },
          { id: 3, created_at: '2026-10-07T00:02:00Z', actor_type: 'system', actor_id: null, event: 'mapping.completed', record_id: 'rec-1', payload: { resources: 4, coded: 3, uncoded: 1 }, hash: 'c'.repeat(64), prev_hash: 'b'.repeat(64) },
          { id: 4, created_at: '2026-10-07T00:05:00Z', actor_type: 'user', actor_id: 'rev-1', event: 'record.committed', record_id: 'rec-1', payload: { mode: 'human' }, hash: 'd'.repeat(64), prev_hash: 'c'.repeat(64) },
        ],
      },
      routing_decisions: { single: { decision: 'escalate', escalation_reasons: ['below_threshold'], reasoning_trace: 'trace text', rule_version: 'route-v1', thresholds_applied: { MedicationRequest: { threshold: 0.99, pass: false }, _checksum: 'x' } } },
      mapped_resources: { list: [{ id: 'res-1', resource_type: 'MedicationRequest', validation_status: 'pass', validation_issues: [{ severity: 'warning' }], flags: ['uncoded'] }] },
      field_scores: { list: [{ scope: 'record', resource_id: null, score: '0.940' }, { scope: 'resource', resource_id: 'res-1', score: '0.940' }] },
      review_tasks: { list: [{ kind: 'escalation', status: 'completed', claimed_by: 'rev-1', claimed_at: '2026-10-07T00:03:00Z', completed_at: '2026-10-07T00:05:00Z' }] },
      review_corrections: { list: [{ field_key: 'medication[0].dose_value', action: 'correct', original_value: 500, corrected_value: 250, original_code: null, corrected_code: null, note: 'printed 250', reviewer_id: 'rev-1', reviewed_at: '2026-10-07T00:05:00Z' }] },
      profiles: { list: [{ id: 'rev-1', full_name: 'Rita Reviewer', email: 'r@example.org' }] },
    }
    state.tables.fhir_resources = { list: [{ id: 'res-1', commit_mode: 'human', created_at: '2026-10-07T00:05:00Z' }] }
  }

  it('joins the audit chain with what each stage stored', async () => {
    seed()
    const result = await reconstructRecord(admin, 'rec-1')
    expect(result.consent).toMatchObject({ result: 'valid', artifact_ref: 'ABDM-1' })
    expect(result.ocr).toEqual({ engine: 'textract', confidence: 0.97, pages: 2 })
    expect(result.extraction).toMatchObject({ model_id: 'model-x', fields_found: 12, fields_not_found: 3, prompt_versions: { extraction: 'pv-1' } })
    expect(result.mapping).toEqual({ resources: 4, coded: 3, uncoded: 1 })
    expect(result.validation).toEqual([{ resource_type: 'MedicationRequest', status: 'pass', error_count: 0, flags: ['uncoded'] }])
    expect(result.scores).toMatchObject({ aggregate: 0.94, resources: [{ resource_type: 'MedicationRequest', score: 0.94, threshold: 0.99, pass: false }] })
    expect(result.routing).toMatchObject({ decision: 'escalate', reasons: ['below_threshold'] })
    expect(result.review.corrections).toMatchObject([{ field_key: 'medication[0].dose_value', original_value: 500, corrected_value: 250, reviewer_name: 'Rita Reviewer' }])
    expect(result.review.tasks[0]?.claimed_by_name).toBe('Rita Reviewer')
    expect(result.commit).toMatchObject({ mode: 'human', resource_ids: ['res-1'] })
  })

  it('orders the chain, names actors and flags a row whose hash does not verify', async () => {
    seed()
    const { chain } = await reconstructRecord(admin, 'rec-1')
    expect(chain.map((row) => row.id)).toEqual([1, 2, 3, 4])
    expect(chain[3]?.actor_name).toBe('Rita Reviewer')
    expect(chain.map((row) => row.hash_ok)).toEqual([true, true, false, true])
  })

  it('audits the read without any record values', async () => {
    seed()
    await reconstructRecord(admin, 'rec-1')
    expect(mocks.appendAudit.mock.calls[0]?.[0]).toMatchObject({ event: 'audit.reconstructed', payload: { chain_entries: 4 } })
  })

  it('answers 404 for a record outside the organisation', async () => {
    seed()
    state.tables.ingestion_records = { single: undefined as never }
    await expect(reconstructRecord(admin, 'rec-1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reconstructs an escalated record that was never committed', async () => {
    seed()
    state.tables.fhir_resources = { list: [] }
    const result = await reconstructRecord(admin, 'rec-1')
    expect(result.commit).toBeNull()
  })
})
