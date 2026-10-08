import { beforeEach, describe, expect, it, vi } from 'vitest'

const state: { rows: unknown; error: { message: string } | null; check: { data: unknown; error: { message: string } | null } } = {
  rows: [],
  error: null,
  check: { data: null, error: null },
}

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'eq']) chain[method] = () => chain
      chain.maybeSingle = () => Promise.resolve(state.check)
      chain.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(table === 'consent_artifacts' ? { data: state.rows, error: state.error } : state.check).then(resolve)
      return chain
    },
  }),
}))
vi.mock('@/server/config/env', () => ({ getEnv: () => ({ CONSENT_MODE: 'stub' }) }))
vi.mock('@/server/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { AppError } from '@/lib/api/errors'
import {
  CONSENT_TIMEOUT_MS,
  assertConsentValid,
  getConsentService,
  verifyConsent,
  type ConsentService,
} from '@/server/services/consent/ConsentService'
import { StubConsentLedger } from '@/server/services/consent/StubConsentLedger'
import type { ConsentQuery, ConsentVerdict } from '@/types/consent'

const query: ConsentQuery = {
  orgId: 'org-1',
  sourceId: 'source-1',
  patientId: 'patient-1',
  regime: 'abdm',
  requiredCategories: ['DischargeSummary'],
  at: new Date('2026-10-07T12:00:00Z'),
}

const validRow = {
  id: 'a-1',
  artifact_ref: 'ref-1',
  categories: ['DischargeSummary'],
  valid_from: '2026-10-01T00:00:00Z',
  valid_to: '2026-11-01T00:00:00Z',
  status: 'granted',
  created_at: '2026-10-01T00:00:00Z',
}

beforeEach(() => {
  state.rows = []
  state.error = null
  state.check = { data: null, error: null }
})

describe('StubConsentLedger', () => {
  it('applies the matching rules to the patient artifacts', async () => {
    state.rows = [validRow]
    const verdict = await new StubConsentLedger().verify(query)
    expect(verdict).toMatchObject({ result: 'valid', artifactId: 'a-1' })
  })

  it('reports missing when the patient has no artifacts', async () => {
    expect((await new StubConsentLedger().verify(query)).result).toBe('missing')
  })

  it('fails closed with an error verdict when the ledger query fails', async () => {
    state.error = { message: 'connection refused' }
    const verdict = await new StubConsentLedger().verify(query)
    expect(verdict.result).toBe('error')
    expect(JSON.stringify(verdict)).not.toContain('connection refused')
  })

  it('fails closed on a malformed ledger response', async () => {
    state.rows = [{ id: 'a-1', categories: 'not-an-array' }]
    expect((await new StubConsentLedger().verify(query)).result).toBe('error')
  })
})

describe('verifyConsent (fail-closed wrapper)', () => {
  const service = (impl: () => Promise<ConsentVerdict>): ConsentService => ({ verify: impl })

  it('passes a normal verdict through', async () => {
    const verdict = await verifyConsent(service(async () => ({ result: 'valid', matchedScope: [], detail: {} })), query)
    expect(verdict.result).toBe('valid')
  })

  it('turns an exception into an error verdict instead of throwing', async () => {
    const verdict = await verifyConsent(service(async () => Promise.reject(new Error('boom'))), query)
    expect(verdict).toMatchObject({ result: 'error', detail: { reason: 'exception' } })
  })

  it('turns a timeout into an error verdict', async () => {
    const slow = service(() => new Promise<ConsentVerdict>(() => undefined))
    const verdict = await verifyConsent(slow, query, 20)
    expect(verdict).toMatchObject({ result: 'error', detail: { reason: 'timeout' } })
  })

  it('uses a 5 second default timeout', () => {
    expect(CONSENT_TIMEOUT_MS).toBe(5000)
  })
})

describe('getConsentService', () => {
  it('returns the stub ledger in stub mode', () => {
    expect(getConsentService('stub')).toBeInstanceOf(StubConsentLedger)
  })

  it('fails closed (never falls back to the stub) when the ABDM client is selected but not shipped', () => {
    let thrown: unknown
    try {
      getConsentService('abdm')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).retryable).toBe(false)
  })
})

describe('assertConsentValid', () => {
  it('passes only for a valid consent check', async () => {
    state.check = { data: { result: 'valid' }, error: null }
    await expect(assertConsentValid('rec-1')).resolves.toBeUndefined()
  })

  it.each(['missing', 'expired', 'revoked', 'out_of_scope', 'error'])('refuses %s', async (result) => {
    state.check = { data: { result }, error: null }
    await expect(assertConsentValid('rec-1')).rejects.toMatchObject({ reason: 'CONSENT_REQUIRED', retryable: false })
  })

  it('refuses when no consent check exists yet', async () => {
    await expect(assertConsentValid('rec-1')).rejects.toMatchObject({ reason: 'CONSENT_REQUIRED' })
  })

  it('treats a read failure as retryable, not as consent', async () => {
    state.check = { data: null, error: { message: 'db down' } }
    await expect(assertConsentValid('rec-1')).rejects.toMatchObject({ code: 'INTERNAL', retryable: true })
  })
})
