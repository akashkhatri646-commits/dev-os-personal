import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks, state } = vi.hoisted(() => ({
  mocks: {
    loadRecord: vi.fn(),
    appendAudit: vi.fn(),
    sendAlert: vi.fn(),
    pauseSource: vi.fn(),
    createReviewTask: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    rpc: vi.fn(),
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
      for (const method of ['eq', 'neq', 'in', 'not', 'lt', 'order', 'limit', 'or', 'select']) query[method] = () => query
      query.maybeSingle = () => Promise.resolve({ data: entry().single ?? null, error: null })
      query.single = () => Promise.resolve({ data: entry().single ?? null, error: null })
      query.then = (resolve: (value: unknown) => unknown) => resolve({ data: entry().list ?? [], count: entry().count ?? (entry().list ?? []).length, error: null })
      return {
        select: () => query,
        insert: (values: unknown) => {
          mocks.insert(table, values)
          return { select: () => query }
        },
        update: (values: unknown) => {
          mocks.update(table, values)
          const result: Record<string, unknown> = {}
          for (const method of ['eq', 'in', 'lt']) result[method] = () => result
          result.then = (resolve: (value: unknown) => unknown) => resolve({ error: null })
          return result
        },
      }
    },
  }),
}))
vi.mock('@/server/config/env', () => ({ getEnv: () => state.env }))
vi.mock('@/server/pipeline/orchestrator', () => ({ loadRecord: mocks.loadRecord }))
vi.mock('@/server/services/audit/auditLog', () => ({ appendAudit: mocks.appendAudit, appendAuditBestEffort: mocks.appendAudit }))
vi.mock('@/server/services/alerts/alerts', () => ({ sendAlert: mocks.sendAlert }))
vi.mock('@/server/services/sources/sourceService', () => ({ pauseSource: mocks.pauseSource }))
vi.mock('@/server/services/review/tasks', () => ({ createReviewTask: mocks.createReviewTask }))
vi.mock('@/server/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { ENTERED_IN_ERROR_TAG, isEnteredInError, markEnteredInError } from '@/server/services/fhir/supersede'
import { rollbackPrompt } from '@/server/services/prompts/rollback'
import { getSystemBanners } from '@/server/services/safety/banners'
import { BUDGET_DEFER_SECONDS, budgetExceeded, recordSpend } from '@/server/services/safety/budget'
import { BREAKER_COOLDOWN_MS, evaluateBreaker, getBreakerState, resetBreakerCache } from '@/server/services/safety/breaker'
import { bulkCreateReviews, pauseAllSources, reportDownstreamError, updateIncident } from '@/server/services/safety/incidentService'
import { errorReportBodySchema, updateIncidentBodySchema } from '@/lib/validation/safety'
import type { AuthUser } from '@/types/domain'

const admin: AuthUser = { userId: 'adm-1', email: null, orgId: 'org-1', orgName: null, fullName: null, role: 'admin' }
const reviewer: AuthUser = { ...admin, userId: 'rev-1', role: 'reviewer' }

const RECORD = '3f2b1c0e-6f6e-4c5d-9e0a-0a1b2c3d4e5f'
const RESOURCE = '8a1d1e6e-1b0f-4f0f-8c5e-5e4c1f0a9d11'

const incidentRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'inc-1',
  record_id: RECORD,
  fhir_resource_id: RESOURCE,
  reported_by: 'rev-1',
  description: 'The dose does not match the discharge summary',
  severity: 'high',
  status: 'open',
  source_paused: true,
  root_cause: null,
  resolution_note: null,
  resolved_at: null,
  created_at: '2026-10-07T00:00:00Z',
  ingestion_records: { source_id: 's-1', provider_sources: { name: 'City Hospital' } },
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  resetBreakerCache()
  state.env = { LLM_DAILY_BUDGET_USD: 100, SYSTEM_AUTOCOMMIT_ENABLED: true }
  mocks.loadRecord.mockResolvedValue({ id: RECORD, org_id: 'org-1', source_id: 's-1' })
  state.tables = {
    fhir_resources: { single: { id: RESOURCE, resource: { resourceType: 'MedicationRequest', status: 'active' } } },
    downstream_errors: { single: incidentRow(), list: [incidentRow()], count: 1 },
    profiles: { list: [{ id: 'rev-1', full_name: 'Rita Reviewer', email: 'r@example.org' }] },
  }
})

describe('markEnteredInError', () => {
  it('tags the resource and sets the status without deleting anything', () => {
    const original = { resourceType: 'MedicationRequest', status: 'active', meta: { tag: [{ code: 'ai-extracted' }] } }
    const marked = markEnteredInError(original) as Record<string, any>
    expect(marked.status).toBe('entered-in-error')
    expect(marked.meta.tag).toEqual([{ code: 'ai-extracted' }, ENTERED_IN_ERROR_TAG])
    expect(original.status).toBe('active')
    expect(isEnteredInError(marked)).toBe(true)
    expect(isEnteredInError(original)).toBe(false)
  })

  it('uses the verification status for conditions and allergies, and does not tag twice', () => {
    const condition = markEnteredInError({ resourceType: 'Condition' }) as Record<string, any>
    expect(condition.verificationStatus.coding[0].code).toBe('entered-in-error')
    expect(condition.status).toBeUndefined()
    const twice = markEnteredInError(markEnteredInError({ resourceType: 'Observation', status: 'final' })) as Record<string, any>
    expect(twice.meta.tag.filter((tag: { code: string }) => tag.code === 'entered-in-error')).toHaveLength(1)
  })
})

describe('reportDownstreamError', () => {
  const body = { description: 'The dose does not match the discharge summary', severity: 'high' as const, fhir_resource_id: RESOURCE }

  it('pauses the source, marks the resource, queues the review first and alerts on a high severity', async () => {
    const incident = await reportDownstreamError(reviewer, RECORD, body)
    expect(incident).toMatchObject({ severity: 'high', source_paused: true, source_name: 'City Hospital', reported_by_name: 'Rita Reviewer' })
    expect(mocks.pauseSource).toHaveBeenCalledWith(reviewer, 's-1', 'Downstream error reported (high)')
    expect(mocks.update).toHaveBeenCalledWith('fhir_resources', { resource: expect.objectContaining({ status: 'entered-in-error' }) })
    expect(mocks.createReviewTask).toHaveBeenCalledWith(RECORD, 'downstream_error_review', 999)
    expect(mocks.appendAudit.mock.calls[0]?.[0]).toMatchObject({ event: 'error.reported', payload: { severity: 'high', source_paused: true, resource_marked: true } })
    expect(JSON.stringify(mocks.appendAudit.mock.calls[0]?.[0].payload)).not.toContain('dose')
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1)
  })

  it('only queues the review for a low severity: no pause, no change to the resource, no alert', async () => {
    state.tables.downstream_errors = { single: incidentRow({ severity: 'low', source_paused: false }), list: [] }
    await reportDownstreamError(reviewer, RECORD, { ...body, severity: 'low' })
    expect(mocks.pauseSource).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.createReviewTask).toHaveBeenCalledTimes(1)
    expect(mocks.sendAlert).not.toHaveBeenCalled()
  })

  it('pauses at medium severity without an alert', async () => {
    await reportDownstreamError(reviewer, RECORD, { ...body, severity: 'medium' })
    expect(mocks.pauseSource).toHaveBeenCalledTimes(1)
    expect(mocks.sendAlert).not.toHaveBeenCalled()
  })

  it('answers 404 for a record in another organisation or a resource from another record', async () => {
    mocks.loadRecord.mockResolvedValue({ id: RECORD, org_id: 'org-2', source_id: 's-1' })
    await expect(reportDownstreamError(reviewer, RECORD, body)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    mocks.loadRecord.mockResolvedValue({ id: RECORD, org_id: 'org-1', source_id: 's-1' })
    state.tables.fhir_resources = { single: undefined as never }
    await expect(reportDownstreamError(reviewer, RECORD, body)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.pauseSource).not.toHaveBeenCalled()
  })

  it('validates the report', () => {
    expect(errorReportBodySchema.safeParse({ description: 'short', severity: 'high' }).success).toBe(false)
    expect(errorReportBodySchema.safeParse({ description: 'long enough text', severity: 'urgent' }).success).toBe(false)
    expect(errorReportBodySchema.safeParse({ description: 'long enough text', severity: 'low' }).success).toBe(true)
  })
})

describe('updateIncident', () => {
  it('needs a root cause to resolve', () => {
    expect(updateIncidentBodySchema.safeParse({ status: 'resolved' }).success).toBe(false)
    expect(updateIncidentBodySchema.safeParse({ status: 'resolved', root_cause: 'mapping' }).success).toBe(true)
    expect(updateIncidentBodySchema.safeParse({ status: 'investigating' }).success).toBe(true)
  })

  it('resolves the incident, closes its review task and audits the change', async () => {
    await updateIncident(admin, 'inc-1', { status: 'resolved', root_cause: 'mapping', note: 'wrong brand mapping' })
    expect(mocks.update).toHaveBeenCalledWith('downstream_errors', expect.objectContaining({ status: 'resolved', root_cause: 'mapping', resolved_by: 'adm-1' }))
    expect(mocks.update).toHaveBeenCalledWith('review_tasks', expect.objectContaining({ status: 'completed' }))
    expect(mocks.appendAudit.mock.calls[0]?.[0]).toMatchObject({ event: 'error.updated', payload: { error_id: 'inc-1', status: 'resolved', root_cause: 'mapping' } })
  })

  it('does not close the task when only moving to investigating, and refuses to change a resolved incident', async () => {
    await updateIncident(admin, 'inc-1', { status: 'investigating' })
    expect(mocks.update).not.toHaveBeenCalledWith('review_tasks', expect.anything())
    state.tables.downstream_errors = { single: incidentRow({ status: 'resolved' }) }
    await expect(updateIncident(admin, 'inc-1', { status: 'investigating' })).rejects.toMatchObject({ reason: 'ALREADY_RESOLVED' })
  })
})

describe('bulkCreateReviews', () => {
  const ids = [RECORD, '5b3c3d1e-0c1d-4e2f-8a9b-1c2d3e4f5a6b']

  it('creates one task per record that has none open', async () => {
    state.tables.ingestion_records = { list: ids.map((id) => ({ id })) }
    state.tables.review_tasks = { list: [{ record_id: ids[0] }] }
    const result = await bulkCreateReviews(admin, { record_ids: ids })
    expect(result).toEqual({ created: 1, already_open: 1 })
    expect(mocks.createReviewTask).toHaveBeenCalledTimes(1)
    expect(mocks.createReviewTask).toHaveBeenCalledWith(ids[1], 'downstream_error_review', 500)
  })

  it('refuses when any record is not in the organisation', async () => {
    state.tables.ingestion_records = { list: [{ id: ids[0] }] }
    await expect(bulkCreateReviews(admin, { record_ids: ids })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.createReviewTask).not.toHaveBeenCalled()
  })
})

describe('pauseAllSources', () => {
  it('pauses every source with auto-commit on and alerts once', async () => {
    state.tables.provider_sources = { list: [{ id: 's-1' }, { id: 's-2' }] }
    expect(await pauseAllSources(admin, { reason: 'bad prompt rollout' })).toEqual({ paused: 2 })
    expect(mocks.pauseSource).toHaveBeenCalledTimes(2)
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1)
  })

  it('does nothing, and sends no alert, when no source has auto-commit on', async () => {
    state.tables.provider_sources = { list: [] }
    expect(await pauseAllSources(admin, { reason: 'bad prompt rollout' })).toEqual({ paused: 0 })
    expect(mocks.sendAlert).not.toHaveBeenCalled()
  })
})

const failure = (secondsAgo: number) => ({ event: 'worker.upstream_failure', created_at: new Date(Date.now() - secondsAgo * 1000).toISOString() })

describe('circuit breaker', () => {
  const now = Date.now()

  it('opens after five failures in a row within two minutes', () => {
    const state = evaluateBreaker([failure(5), failure(30), failure(60), failure(90), failure(110)], now)
    expect(state.open).toBe(true)
    expect(state.retryAt).toBeGreaterThan(now)
  })

  it('stays closed for fewer than five, a success in between, or failures spread over more than two minutes', () => {
    expect(evaluateBreaker([failure(5), failure(30), failure(60), failure(90)], now).open).toBe(false)
    expect(evaluateBreaker([failure(5), failure(30), { event: 'extraction.completed', created_at: new Date().toISOString() }, failure(90), failure(100)], now).open).toBe(false)
    expect(evaluateBreaker([failure(5), failure(30), failure(60), failure(90), failure(300)], now).open).toBe(false)
  })

  it('tries jobs again five minutes after the newest failure, and reopens on the next failure', () => {
    const old = [failure(400), failure(410), failure(420), failure(430), failure(440)]
    expect(evaluateBreaker(old, now).open).toBe(false)
    expect(evaluateBreaker([failure(1), ...old], now).open).toBe(false)
    const reopened = [failure(1), failure(2), failure(3), failure(4), failure(5)]
    expect(evaluateBreaker(reopened, now).open).toBe(true)
    expect(BREAKER_COOLDOWN_MS).toBe(300_000)
  })

  it('reads the recent outcomes from the audit log, and lets jobs run if it cannot', async () => {
    state.tables.audit_log = { list: [failure(5), failure(30), failure(60), failure(90), failure(110)] }
    expect((await getBreakerState()).open).toBe(true)
    resetBreakerCache()
    state.tables.audit_log = { list: [] }
    expect((await getBreakerState()).open).toBe(false)
  })
})

describe('spend cap', () => {
  it('is exceeded once today\'s spend reaches the cap, and off when the cap is zero', async () => {
    mocks.rpc.mockResolvedValue({ data: 99.99, error: null })
    expect(await budgetExceeded()).toBe(false)
    mocks.rpc.mockResolvedValue({ data: 100, error: null })
    expect(await budgetExceeded()).toBe(true)
    state.env = { LLM_DAILY_BUDGET_USD: 0 }
    expect(await budgetExceeded()).toBe(false)
    expect(BUDGET_DEFER_SECONDS).toBe(900)
  })

  it('fails with a retryable error when the spend cannot be read', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'down' } })
    await expect(budgetExceeded()).rejects.toMatchObject({ retryable: true })
  })

  it('alerts once, when a call takes the day across the cap', async () => {
    mocks.rpc.mockResolvedValue({ data: [99, 101], error: null })
    await recordSpend(2)
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1)
    mocks.rpc.mockResolvedValue({ data: [101, 103], error: null })
    await recordSpend(2)
    mocks.rpc.mockResolvedValue({ data: [10, 12], error: null })
    await recordSpend(2)
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1)
    await recordSpend(0)
    expect(mocks.rpc).toHaveBeenCalledTimes(3)
  })
})

describe('rollbackPrompt', () => {
  const rows = (single: unknown, list: unknown[] = []) => {
    state.tables.prompt_versions = { single, list }
  }

  it('goes back to the previous version and audits it', async () => {
    rows({ id: 'pv-2', version: 'extraction-v2', created_at: '2026-10-02T00:00:00Z' }, [{ id: 'pv-1', version: 'extraction-v1', created_at: '2026-10-01T00:00:00Z' }])
    const result = await rollbackPrompt(admin, 'extraction', undefined)
    expect(result).toEqual({ component: 'extraction', active_version: 'extraction-v1', previous_version: 'extraction-v2' })
    expect(mocks.update).toHaveBeenNthCalledWith(1, 'prompt_versions', { active: false })
    expect(mocks.update).toHaveBeenNthCalledWith(2, 'prompt_versions', { active: true })
    expect(mocks.appendAudit.mock.calls[0]?.[0]).toMatchObject({ event: 'prompt.rolled_back', payload: { from_version: 'extraction-v2', to_version: 'extraction-v1' } })
  })

  it('refuses when there is nothing earlier, or the version is already active', async () => {
    rows({ id: 'pv-1', version: 'extraction-v1', created_at: '2026-10-01T00:00:00Z' }, [])
    await expect(rollbackPrompt(admin, 'extraction', undefined)).rejects.toMatchObject({ reason: 'NO_PREVIOUS_VERSION' })
    await expect(rollbackPrompt(admin, 'extraction', 'extraction-v1')).rejects.toMatchObject({ reason: 'ALREADY_ACTIVE' })
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('refuses when no version is active', async () => {
    rows(undefined)
    await expect(rollbackPrompt(admin, 'mapping', undefined)).rejects.toMatchObject({ reason: 'NO_ACTIVE_VERSION' })
  })
})

describe('getSystemBanners', () => {
  it('shows nothing when all is well', async () => {
    mocks.rpc.mockResolvedValue({ data: 1, error: null })
    state.tables.audit_log = { list: [] }
    state.tables.provider_sources = { count: 0 }
    state.tables.downstream_errors = { count: 0 }
    expect(await getSystemBanners(admin)).toEqual([])
  })

  it('warns about the kill switch, a delayed pipeline, the spend cap, paused sources and open incidents', async () => {
    state.env = { LLM_DAILY_BUDGET_USD: 100, SYSTEM_AUTOCOMMIT_ENABLED: false }
    mocks.rpc.mockResolvedValue({ data: 150, error: null })
    state.tables.audit_log = { list: [failure(5), failure(30), failure(60), failure(90), failure(110)] }
    state.tables.provider_sources = { count: 2 }
    state.tables.downstream_errors = { count: 1 }
    const banners = await getSystemBanners(admin)
    expect(banners.map((banner) => banner.id)).toEqual(['kill-switch', 'breaker', 'budget', 'paused-sources', 'incidents'])
    expect(banners.find((banner) => banner.id === 'incidents')?.tone).toBe('danger')
  })

  it('shows reviewers only the system-wide warnings', async () => {
    mocks.rpc.mockResolvedValue({ data: 1, error: null })
    state.tables.audit_log = { list: [] }
    state.tables.provider_sources = { count: 3 }
    state.tables.downstream_errors = { count: 3 }
    expect(await getSystemBanners(reviewer)).toEqual([])
  })

  it('leaves banners out rather than failing the page', async () => {
    mocks.rpc.mockRejectedValue(new Error('down'))
    await expect(getSystemBanners(admin)).resolves.toBeInstanceOf(Array)
  })
})
