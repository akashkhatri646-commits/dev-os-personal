import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks, state } = vi.hoisted(() => ({
  mocks: {
    assertConsentValid: vi.fn(),
    appendAudit: vi.fn(),
    sendAlert: vi.fn(),
    setStatus: vi.fn(),
    runConsentCheck: vi.fn(),
    rpc: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    deleted: vi.fn(),
  },
  state: {
    tables: {} as Record<string, { single?: unknown; list?: unknown[]; count?: number }>,
    env: {} as Record<string, unknown>,
  },
}))

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      const entry = () => state.tables[table] ?? {}
      const query: Record<string, unknown> = {}
      for (const method of ['eq', 'limit']) query[method] = () => query
      query.maybeSingle = () => Promise.resolve({ data: entry().single ?? null, error: null })
      query.then = (resolve: (value: unknown) => unknown) => resolve({ data: entry().list ?? [], count: entry().count ?? 0, error: null })
      return {
        select: () => query,
        upsert: (values: unknown) => {
          mocks.upsert(table, values)
          return Promise.resolve({ error: null })
        },
        insert: (values: unknown) => {
          mocks.insert(table, values)
          return Promise.resolve({ error: null })
        },
        delete: () => ({
          eq: () => {
            mocks.deleted(table)
            return Promise.resolve({ error: null })
          },
        }),
        update: (values: unknown) => {
          mocks.update(table, values)
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
  }),
}))
vi.mock('@/server/config/env', () => ({ getEnv: () => state.env }))
vi.mock('@/server/services/audit/auditLog', () => ({ appendAudit: mocks.appendAudit }))
vi.mock('@/server/services/alerts/alerts', () => ({ sendAlert: mocks.sendAlert }))
vi.mock('@/server/services/consent/ConsentService', () => ({ assertConsentValid: mocks.assertConsentValid }))
vi.mock('@/server/services/consent/runCheck', () => ({ runConsentCheck: mocks.runConsentCheck }))
vi.mock('@/server/pipeline/orchestrator', () => ({ setStatus: mocks.setStatus }))
vi.mock('@/server/services/sources/sourceService', () => ({
  loadActiveThresholds: async () => [{ resource_type: '*', threshold: 0.9, version: 1 }],
}))

import { commitStage } from '@/server/pipeline/stages/commit'
import { routeStage } from '@/server/pipeline/stages/route'
import { scoreStage } from '@/server/pipeline/stages/score'
import { thresholdsChecksum } from '@/server/services/routing/decide'
import type { RecordRow } from '@/server/pipeline/orchestrator'

const record: RecordRow = {
  id: 'rec-1',
  org_id: 'org-1',
  source_id: 's-1',
  patient_id: 'p-1',
  doc_type: 'discharge_summary',
  input_kind: 'pdf',
  data_categories: ['DischargeSummary'],
  status: 'routing',
  status_reason: null,
  created_at: '2026-10-07T00:00:00Z',
}
const context = { record, job: {} as never }

const scoreRows = [
  { scope: 'resource', resource_id: 'r1', score: 0.97, components: {} },
  { scope: 'record', resource_id: null, score: 0.97, components: { missing_required: [] } },
]

function seedRouting(overrides: { source?: Record<string, unknown>; flags?: string[]; scores?: unknown[] } = {}) {
  state.tables = {
    provider_sources: { single: { auto_commit_enabled: true, holdback_pct: 0, ...overrides.source } },
    documents: { single: { ocr_confidence: 0.99 } },
    mapped_resources: { list: [{ id: 'r1', resource_type: 'Condition', flags: overrides.flags ?? [], validation_status: 'pass' }] },
    field_scores: { list: overrides.scores ?? scoreRows },
    extracted_fields: { count: 0 },
    ingestion_records: { single: { prompt_set: {} } },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.env = { OCR_CONFIDENCE_FLOOR: 0.8, SYSTEM_AUTOCOMMIT_ENABLED: true }
  mocks.rpc.mockResolvedValue({ error: null })
})

describe('routeStage', () => {
  it('re-checks consent and never routes without it', async () => {
    seedRouting()
    mocks.assertConsentValid.mockRejectedValueOnce(new Error('consent'))
    await expect(routeStage(context)).rejects.toThrow('consent')
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('auto-commits a clear record, storing the decision with a checksum and auditing it without PHI', async () => {
    seedRouting()
    expect(await routeStage(context)).toEqual({ kind: 'advance' })
    const [table, row] = mocks.upsert.mock.calls[0] as [string, Record<string, any>]
    expect(table).toBe('routing_decisions')
    expect(row).toMatchObject({ decision: 'auto_commit', escalation_reasons: [], aggregate_score: 0.97, rule_version: 'route-v1' })
    const { _checksum, ...applied } = row.thresholds_applied
    expect(_checksum).toBe(thresholdsChecksum(applied))
    expect(mocks.appendAudit.mock.calls[0]?.[0]).toMatchObject({ event: 'routing.decided', payload: { decision: 'auto_commit', reasons: [] } })
  })

  it('escalates with the first reason and a priority when the source is not enabled', async () => {
    seedRouting({ source: { auto_commit_enabled: false } })
    const outcome = await routeStage(context)
    expect(outcome).toMatchObject({ kind: 'escalate', reason: 'source_not_enabled' })
    expect((outcome as { priority: number }).priority).toBeGreaterThan(0)
    expect(mocks.upsert.mock.calls[0]?.[1]).toMatchObject({ decision: 'escalate', escalation_reasons: ['source_not_enabled'] })
  })

  it('escalates a missing required field as ungrounded', async () => {
    seedRouting({ scores: [scoreRows[0], { scope: 'record', resource_id: null, score: 0.3, components: { missing_required: ['encounter.discharge_date'] } }] })
    expect(await routeStage(context)).toMatchObject({ kind: 'escalate', reason: 'ungrounded' })
  })

  it('files an audit sample as a holdback task and marks the record', async () => {
    seedRouting({ source: { holdback_pct: 100 } })
    expect(await routeStage(context)).toMatchObject({ kind: 'escalate', reason: 'holdback', taskKind: 'holdback_audit' })
    expect(mocks.update).toHaveBeenCalledWith('ingestion_records', { holdback: true })
  })

  it('stops routing everything when the global kill switch is off', async () => {
    seedRouting()
    state.env = { OCR_CONFIDENCE_FLOOR: 0.8, SYSTEM_AUTOCOMMIT_ENABLED: false }
    expect(await routeStage(context)).toMatchObject({ kind: 'escalate', reason: 'source_not_enabled' })
  })
})

describe('commitStage', () => {
  const applied = { Condition: { threshold: 0.9, version: 1, score: 0.97, pass: true } }
  const seedCommit = (overrides: { checkedAt?: string; sourceEnabled?: boolean; checksum?: string; decision?: string } = {}) => {
    state.tables = {
      consent_checks: { single: { checked_at: overrides.checkedAt ?? new Date().toISOString() } },
      provider_sources: { single: { auto_commit_enabled: overrides.sourceEnabled ?? true } },
      routing_decisions: {
        single: { decision: overrides.decision ?? 'auto_commit', thresholds_applied: { ...applied, _checksum: overrides.checksum ?? thresholdsChecksum(applied) } },
      },
      fhir_resources: { count: 1 },
    }
  }

  it('commits through the database function in auto mode and finishes', async () => {
    seedCommit()
    expect(await commitStage(context)).toEqual({ kind: 'finished' })
    expect(mocks.rpc).toHaveBeenCalledWith('commit_record', { p_record_id: 'rec-1', p_mode: 'auto', p_reviewer_id: null })
    expect(mocks.runConsentCheck).not.toHaveBeenCalled()
  })

  it('never commits without a valid consent check', async () => {
    seedCommit()
    mocks.assertConsentValid.mockRejectedValueOnce(new Error('consent'))
    await expect(commitStage(context)).rejects.toThrow('consent')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('asks the ledger again when the stored answer is over 24 hours old, and commits when still valid', async () => {
    seedCommit({ checkedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() })
    mocks.runConsentCheck.mockResolvedValue({ missingSource: false, verdict: { result: 'valid', matchedScope: [] } })
    expect(await commitStage(context)).toEqual({ kind: 'finished' })
    expect(mocks.runConsentCheck).toHaveBeenCalledTimes(1)
    expect(mocks.rpc).toHaveBeenCalled()
  })

  it('blocks the record and commits nothing when consent was revoked in the meantime', async () => {
    seedCommit({ checkedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() })
    mocks.runConsentCheck.mockResolvedValue({ missingSource: false, verdict: { result: 'revoked', matchedScope: [] } })
    expect(await commitStage(context)).toEqual({ kind: 'finished' })
    expect(mocks.setStatus).toHaveBeenCalledWith(record, 'blocked_consent', { reason: 'revoked' })
    expect(mocks.sendAlert).toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('retries when the ledger cannot be reached on the re-check', async () => {
    seedCommit({ checkedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() })
    mocks.runConsentCheck.mockResolvedValue({ missingSource: false, verdict: { result: 'error', matchedScope: [] } })
    await expect(commitStage(context)).rejects.toMatchObject({ retryable: true })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('aborts to review when the source was paused after routing', async () => {
    seedCommit({ sourceEnabled: false })
    expect(await commitStage(context)).toEqual({ kind: 'escalate', reason: 'source_paused' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('refuses a decision whose stored thresholds no longer verify, or that is not an auto-commit', async () => {
    seedCommit({ checksum: 'tampered' })
    expect(await commitStage(context)).toEqual({ kind: 'escalate', reason: 'stage_error:commit' })
    seedCommit({ decision: 'escalate' })
    expect(await commitStage(context)).toEqual({ kind: 'escalate', reason: 'stage_error:commit' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('treats a repeat commit as success once the resources exist', async () => {
    seedCommit()
    mocks.rpc.mockResolvedValue({ error: { message: 'already_committed' } })
    expect(await commitStage(context)).toEqual({ kind: 'finished' })
  })

  it('does not treat already_committed as success when nothing was stored', async () => {
    seedCommit()
    state.tables.fhir_resources = { count: 0 }
    mocks.rpc.mockResolvedValue({ error: { message: 'already_committed' } })
    await expect(commitStage(context)).rejects.toMatchObject({ retryable: true })
  })

  it('raises an alert and a final error when the database refuses the commit', async () => {
    seedCommit()
    mocks.rpc.mockResolvedValue({ error: { message: 'validation_not_passed' } })
    await expect(commitStage(context)).rejects.toMatchObject({ retryable: false, reason: 'VALIDATION_NOT_PASSED' })
    expect(mocks.sendAlert).toHaveBeenCalled()
  })

  it('retries a transient database failure', async () => {
    seedCommit()
    mocks.rpc.mockResolvedValue({ error: { message: 'connection reset' } })
    await expect(commitStage(context)).rejects.toMatchObject({ retryable: true })
    expect(mocks.sendAlert).not.toHaveBeenCalled()
  })
})

describe('scoreStage', () => {
  it('stores field, resource and record scores and audits only numbers', async () => {
    state.tables = {
      extracted_fields: {
        list: ['name', 'dose_value', 'dose_unit', 'frequency'].map((attr) => ({
          field_key: `medication[0].${attr}`,
          found: true,
          grounded: true,
          basis: 'stated',
          model_confidence: 1,
          source_span: { block_ids: ['b1'] },
        })),
      },
      mapped_resources: {
        list: [
          {
            id: 'r1',
            resource_type: 'MedicationRequest',
            source_ref: 'medication[0]',
            codings: [{ field_key: 'medication[0].name', match_confidence: 1 }],
            flags: [],
            validation_status: 'pass',
          },
        ],
      },
      documents: { single: { normalized_text: [{ blocks: [{ id: 'b1', confidence: 0.99 }] }] } },
    }
    expect(await scoreStage(context)).toEqual({ kind: 'advance' })
    expect(mocks.deleted).toHaveBeenCalledWith('field_scores')
    const rows = mocks.insert.mock.calls.flatMap((call) => call[1] as { scope: string }[])
    expect(rows.map((row) => row.scope)).toEqual(['field', 'field', 'field', 'field', 'resource', 'record'])
    expect(mocks.appendAudit.mock.calls[0]?.[0]).toMatchObject({ event: 'scoring.completed', payload: { aggregate: 1, resources: 1, fields: 4, missing_required: 0 } })
  })
})
