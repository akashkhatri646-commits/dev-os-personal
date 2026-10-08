import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthUser } from '@/types/domain'

// A tiny chainable fake of the Supabase query builder. Each table has a queue of results.
type Result = { data?: unknown; error?: { code?: string; message: string } | null }
const results: Record<string, Result[]> = {}
const updates: { table: string; values: unknown }[] = []
const rpcResults: Record<string, Result> = {}
const rpcCalls: { name: string; args: unknown }[] = []
const appendAudit = vi.fn()

function nextResult(table: string): Result {
  return results[table]?.shift() ?? { data: null, error: null }
}

function builder(table: string) {
  const chain: Record<string, unknown> = {}
  const passthrough = ['select', 'eq', 'neq', 'in', 'is', 'order', 'limit', 'or']
  for (const method of passthrough) chain[method] = () => chain
  chain.update = (values: unknown) => {
    updates.push({ table, values })
    return chain
  }
  chain.insert = () => chain
  chain.maybeSingle = () => Promise.resolve(nextResult(table))
  chain.then = (resolve: (value: Result) => unknown) => Promise.resolve(nextResult(table)).then(resolve)
  return chain
}

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => builder(table),
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args })
      return Promise.resolve(rpcResults[name] ?? { data: null, error: null })
    },
  }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({ from: (table: string) => builder(table) }),
}))
vi.mock('@/server/config/constants', () => ({
  getRuntimeConfig: () => ({
    enabledDocTypes: ['discharge_summary'],
    holdbackPctDefault: 10,
    defaultThreshold: 0.97,
    highRiskThreshold: 0.99,
  }),
}))
vi.mock('@/server/services/audit/auditLog', () => ({
  appendAudit: (...args: unknown[]) => appendAudit(...args),
}))
vi.mock('@/server/services/sources/sourceKeys', () => ({
  generateSourceKey: () => ({ key: 'hik_AAAAAAAA_' + 'b'.repeat(40), prefix: 'AAAAAAAA' }),
  hashSourceKey: () => 'hash',
}))

import { AppError } from '@/lib/api/errors'
import {
  createSource,
  enableAutoCommit,
  pauseSource,
  resumeSource,
  setThreshold,
  updateSource,
} from '@/server/services/sources/sourceService'

const actor: AuthUser = {
  userId: '3f2b8c1e-5c1a-4d6e-9c5e-2f7a1b0d9e11',
  email: 'admin@b.co',
  orgId: 'org-1',
  orgName: 'Org',
  fullName: 'Admin',
  role: 'admin',
}

const sourceRow = {
  id: 's-1',
  name: 'City Hospital',
  provider_type: 'hospital',
  size_class: 'large',
  region: null,
  primary_language: 'en',
  doc_types: ['discharge_summary'],
  consent_regime: 'abdm',
  auto_commit_enabled: false,
  pause_reason: null,
  eval_status: 'passed',
  eval_passed_at: null,
  holdback_pct: 10,
  flagged_poor: false,
  created_at: '2026-10-01T00:00:00+00:00',
}

function stubSource(overrides: Record<string, unknown> = {}) {
  results.provider_sources = [{ data: { ...sourceRow, ...overrides }, error: null }]
}

async function catchError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    return error as AppError
  }
  throw new Error('expected rejection')
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(results)) delete results[key]
  for (const key of Object.keys(rpcResults)) delete rpcResults[key]
  updates.length = 0
  rpcCalls.length = 0
})

describe('createSource', () => {
  const input = {
    name: 'City Hospital',
    provider_type: 'hospital' as const,
    size_class: 'large' as const,
    primary_language: 'en',
    doc_types: ['discharge_summary' as const],
    consent_regime: 'abdm' as const,
  }

  it('rejects the HIPAA regime until it is enabled', async () => {
    const error = await catchError(createSource(actor, { ...input, consent_regime: 'hipaa' }))
    expect(error.code).toBe('VALIDATION_FAILED')
    expect(error.reason).toBe('REGIME_NOT_ENABLED')
    expect(rpcCalls).toHaveLength(0)
  })

  it('rejects document types that are not enabled yet', async () => {
    const error = await catchError(createSource(actor, { ...input, doc_types: ['lab_report'] }))
    expect(error.reason).toBe('DOC_TYPE_NOT_ENABLED')
  })

  it('creates the source atomically with default thresholds and returns the key once', async () => {
    rpcResults.create_source_with_defaults = { data: 's-1', error: null }
    const created = await createSource(actor, input)
    expect(created.id).toBe('s-1')
    expect(created.api_key).toMatch(/^hik_/)
    expect(rpcCalls[0]?.args).toMatchObject({
      p_default_threshold: 0.97,
      p_high_risk_threshold: 0.99,
      p_key_hash: 'hash',
    })
    expect(JSON.stringify(rpcCalls)).not.toContain(created.api_key)
    expect(appendAudit).toHaveBeenCalledWith(expect.objectContaining({ event: 'source.created' }))
  })

  it('maps a duplicate name to 409 NAME_TAKEN', async () => {
    rpcResults.create_source_with_defaults = { data: null, error: { code: '23505', message: 'duplicate' } }
    const error = await catchError(createSource(actor, input))
    expect(error.code).toBe('CONFLICT')
    expect(error.reason).toBe('NAME_TAKEN')
  })
})

describe('setThreshold', () => {
  it('rejects a medication threshold below 0.95 without calling the database', async () => {
    stubSource()
    const error = await catchError(
      setThreshold(actor, 's-1', { resource_type: 'MedicationRequest', threshold: 0.9, reason: 'trying lower' }),
    )
    expect(error.reason).toBe('THRESHOLD_TOO_LOW')
    expect(rpcCalls).toHaveLength(0)
  })

  it('writes a new version and audits old and new values', async () => {
    stubSource()
    rpcResults.set_routing_threshold = { data: [{ version: 2, previous: 0.97 }], error: null }
    const result = await setThreshold(actor, 's-1', { resource_type: 'Condition', threshold: 0.95, reason: 'tuned' })
    expect(result).toEqual({ version: 2, previous: 0.97 })
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'threshold.changed',
        payload: { source_id: 's-1', resource_type: 'Condition', old: 0.97, new: 0.95, version: 2 },
      }),
    )
  })

  it('returns 404 for a source outside the organisation', async () => {
    results.provider_sources = [{ data: null, error: null }]
    const error = await catchError(
      setThreshold(actor, 'other', { resource_type: 'Condition', threshold: 0.95, reason: 'tuned' }),
    )
    expect(error.code).toBe('NOT_FOUND')
  })
})

describe('enableAutoCommit', () => {
  it('requires a passed onboarding evaluation', async () => {
    stubSource({ eval_status: 'none' })
    const error = await catchError(enableAutoCommit(actor, 's-1', 'looks good'))
    expect(error.reason).toBe('EVAL_NOT_PASSED')
    expect(updates).toHaveLength(0)
  })

  it('refuses when already enabled or paused', async () => {
    stubSource({ auto_commit_enabled: true })
    expect((await catchError(enableAutoCommit(actor, 's-1', 'again please'))).reason).toBe('ALREADY_ENABLED')
    stubSource({ pause_reason: 'incident' })
    expect((await catchError(enableAutoCommit(actor, 's-1', 'again please'))).reason).toBe('SOURCE_PAUSED')
  })
})

describe('pauseSource', () => {
  it('keeps the first pause reason when already paused (idempotent)', async () => {
    stubSource({ pause_reason: 'first reason' })
    results.provider_sources?.push({ data: sourceRow, error: null })
    results.routing_thresholds = [{ data: [], error: null }]
    results.source_api_keys = [{ data: null, error: null }]
    results.eval_runs = [{ data: null, error: null }]
    results.review_tasks = [{ data: [], error: null }]
    await pauseSource(actor, 's-1', 'second reason').catch(() => undefined)
    expect(updates.some((entry) => entry.table === 'provider_sources')).toBe(false)
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ already_paused: true }) }),
    )
  })
})

describe('resumeSource', () => {
  it('refuses when the source is not paused', async () => {
    stubSource()
    expect((await catchError(resumeSource(actor, 's-1', 'all clear'))).reason).toBe('NOT_PAUSED')
  })

  it('is blocked by an open downstream incident', async () => {
    stubSource({ pause_reason: 'incident' })
    results.downstream_errors = [{ data: [{ id: 'e-1' }], error: null }]
    const error = await catchError(resumeSource(actor, 's-1', 'all clear'))
    expect(error.reason).toBe('OPEN_INCIDENT')
    expect(updates).toHaveLength(0)
  })

  it('requires a passed evaluation even when there is no incident', async () => {
    stubSource({ pause_reason: 'incident', eval_status: 'failed' })
    expect((await catchError(resumeSource(actor, 's-1', 'all clear'))).reason).toBe('EVAL_NOT_PASSED')
  })
})

describe('updateSource', () => {
  it('rejects holdback below 5% while auto-commit is enabled', async () => {
    stubSource({ auto_commit_enabled: true })
    const error = await catchError(updateSource(actor, 's-1', { holdback_pct: 2 }))
    expect(error.reason).toBe('HOLDBACK_TOO_LOW')
    expect(updates).toHaveLength(0)
  })

  it('maps a duplicate name to NAME_TAKEN', async () => {
    stubSource()
    results.provider_sources?.push({ data: null, error: { code: '23505', message: 'dup' } })
    const error = await catchError(updateSource(actor, 's-1', { name: 'Taken Name' }))
    expect(error.reason).toBe('NAME_TAKEN')
  })
})
