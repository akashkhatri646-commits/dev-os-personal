import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks, state } = vi.hoisted(() => ({
  mocks: {
    assertConsentValid: vi.fn(),
    getLlmClient: vi.fn(),
    appendAudit: vi.fn(),
    complete: vi.fn(),
    resourceInserts: vi.fn(),
    resourceDeletes: vi.fn(),
    resourceUpdates: vi.fn(),
    search: vi.fn(),
  },
  state: {
    fields: [] as unknown[],
    mapped: [] as unknown[],
    env: {} as Record<string, unknown>,
  },
}))

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => {
        const result = Promise.resolve({ data: table === 'extracted_fields' ? state.fields : state.mapped, error: null })
        return Object.assign(result, { eq: () => result, maybeSingle: () => Promise.resolve({ data: { cost_usd: 0 }, error: null }) })
      }
      chain.update = (values: unknown) => {
        mocks.resourceUpdates(table, values)
        return { eq: () => Promise.resolve({ error: null }) }
      }
      chain.delete = () => ({
        eq: () => {
          mocks.resourceDeletes()
          return Promise.resolve({ error: null })
        },
      })
      chain.insert = (rows: unknown) => {
        mocks.resourceInserts(rows)
        return Promise.resolve({ error: null })
      }
      return chain
    },
  }),
}))
vi.mock('@/server/config/env', () => ({ getEnv: () => state.env }))
vi.mock('@/server/services/audit/auditLog', () => ({ appendAudit: mocks.appendAudit }))
vi.mock('@/server/services/consent/ConsentService', () => ({ assertConsentValid: mocks.assertConsentValid }))
vi.mock('@/server/services/safety/budget', () => ({ BUDGET_DEFER_SECONDS: 900, budgetExceeded: async () => false, recordSpend: async () => undefined }))
vi.mock('@/server/services/llm/LLMClient', () => ({ getLlmClient: mocks.getLlmClient }))
vi.mock('@/server/services/prompts/promptVersions', () => ({
  getActiveMappingPrompt: async () => ({ id: 'pv', version: 'mapping-v1', template: 'sys', fewShot: [], modelId: 'm' }),
}))
vi.mock('@/server/services/terminology/dictionary', () => ({ loadTermDictionary: async () => new Map(), expandQuery: (q: string) => [q] }))
vi.mock('@/server/services/terminology/search', () => ({
  SupabaseTerminologySearch: class {
    search = mocks.search
    exists = async () => true
  },
  getEmbeddingsClient: () => null,
}))

import type { RecordRow } from '@/server/pipeline/orchestrator'
import { mapStage } from '@/server/pipeline/stages/map'
import { validateStage } from '@/server/pipeline/stages/validate'

const record: RecordRow = {
  id: 'rec-1',
  org_id: 'org-1',
  source_id: 's-1',
  patient_id: 'p-1',
  doc_type: 'discharge_summary',
  input_kind: 'pdf',
  data_categories: ['DischargeSummary'],
  status: 'mapping',
  status_reason: null,
  created_at: '2026-10-07T00:00:00Z',
}
const context = { record, job: {} as never }

const stored = (field_key: string, value: string | number) => ({
  field_key,
  found: true,
  value,
  source_span: { page: 1, block_ids: ['b1'], quote: 'q', char_start: 0, char_end: 1 },
  basis: 'stated',
  model_confidence: 0.9,
})

beforeEach(() => {
  vi.clearAllMocks()
  state.fields = [stored('encounter.class', 'inpatient'), stored('diagnosis[0].text', 'Type 2 diabetes')]
  state.mapped = []
  state.env = { FHIR_VALIDATOR_MODE: 'node', LLM_MODEL_LIGHT: 'light', LLM_MAX_OUTPUT_TOKENS: 1000, LLM_REQUEST_TIMEOUT_MS: 1000 }
  mocks.search.mockResolvedValue([])
  mocks.getLlmClient.mockReturnValue({ complete: mocks.complete })
})

describe('mapStage', () => {
  it('re-checks consent first and never maps when it fails', async () => {
    mocks.assertConsentValid.mockRejectedValueOnce(new Error('consent'))
    await expect(mapStage(context)).rejects.toThrow('consent')
    expect(mocks.resourceInserts).not.toHaveBeenCalled()
  })

  it('escalates when nothing was extracted', async () => {
    state.fields = []
    expect(await mapStage(context)).toEqual({ kind: 'escalate', reason: 'no_data_extracted' })
  })

  it('fails a record that has no patient', async () => {
    expect(await mapStage({ record: { ...record, patient_id: null }, job: {} as never })).toEqual({ kind: 'fail', reason: 'patient_missing' })
  })

  it('stores resources as uncoded without calling the model when there are no candidates', async () => {
    expect(await mapStage(context)).toEqual({ kind: 'advance' })
    expect(mocks.complete).not.toHaveBeenCalled()
    const rows = mocks.resourceInserts.mock.calls[0]?.[0] as { resource_type: string; flags: string[]; validation_status: string }[]
    expect(rows.map((row) => row.resource_type)).toEqual(['Encounter', 'Condition'])
    expect(rows.find((row) => row.resource_type === 'Condition')?.flags).toContain('uncoded')
    expect(rows.every((row) => row.validation_status === 'pending')).toBe(true)
    expect(mocks.resourceDeletes).toHaveBeenCalledTimes(1)
  })

  it('holds the record for retry when candidates exist but no model is configured', async () => {
    mocks.search.mockResolvedValue([{ system: 'snomed', code: '1', display: 'Diabetes', score: 0.9 }])
    mocks.getLlmClient.mockReturnValue(null)
    expect(await mapStage(context)).toEqual({ kind: 'escalate', reason: 'mapping_unavailable' })
    expect(mocks.resourceInserts).not.toHaveBeenCalled()
  })

  it('codes from a verified choice and keeps only counts in the audit event', async () => {
    mocks.search.mockResolvedValue([{ system: 'snomed', code: '44054006', display: 'Diabetes mellitus type 2', score: 0.9 }])
    mocks.complete.mockResolvedValue({
      output: { choices: [{ field_key: 'diagnosis[0].text', candidate_id: 'c1', match_confidence: 0.9, rationale: '' }] },
      usage: { inputTokens: 5, outputTokens: 5 },
      costUsd: null,
      latencyMs: 1,
      model: 'light',
    })
    expect(await mapStage(context)).toEqual({ kind: 'advance' })
    const rows = mocks.resourceInserts.mock.calls[0]?.[0] as { resource_type: string; flags: string[]; resource: unknown }[]
    const condition = rows.find((row) => row.resource_type === 'Condition')
    expect(JSON.stringify(condition?.resource)).toContain('44054006')
    expect(condition?.flags).not.toContain('uncoded')
    const audit = mocks.appendAudit.mock.calls[0]?.[0]
    expect(audit.event).toBe('mapping.completed')
    expect(JSON.stringify(audit.payload)).not.toContain('diabetes')
  })
})

describe('validateStage', () => {
  const mappedRow = (id: string, resource: Record<string, unknown>) => ({ id, resource, profile_url: null })

  it('escalates when there is nothing to validate', async () => {
    expect(await validateStage(context)).toEqual({ kind: 'escalate', reason: 'no_data_extracted' })
  })

  it('stores pass and fail per resource, advances either way, and audits counts only', async () => {
    state.mapped = [
      mappedRow('e1', { resourceType: 'Encounter', id: 'e1', status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'IMP' }, subject: { reference: 'Patient/p-1' } }),
      mappedRow('e2', { resourceType: 'Encounter', id: 'e2', status: 'finished', subject: { reference: 'Patient/p-1' } }),
    ]
    expect(await validateStage(context)).toEqual({ kind: 'advance' })
    const updates = mocks.resourceUpdates.mock.calls.map((call) => call[1] as { validation_status: string })
    expect(updates.map((update) => update.validation_status)).toEqual(['pass', 'fail'])
    expect(mocks.appendAudit.mock.calls[0]?.[0]).toMatchObject({ event: 'validation.completed', payload: { resources: 2, passed: 1, failed: 1 } })
  })
})
