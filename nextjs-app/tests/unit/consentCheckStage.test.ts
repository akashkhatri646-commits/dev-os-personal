import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsentVerdict } from '@/types/consent'

const { mocks, state } = vi.hoisted(() => ({
  mocks: {
    verify: vi.fn(),
    getConsentService: vi.fn(),
    setStatus: vi.fn(),
    appendAudit: vi.fn(),
    sendAlert: vi.fn(),
    upsert: vi.fn(),
  },
  state: {
    source: { data: { consent_regime: 'abdm' } as unknown, error: null as { message: string } | null },
    upsertError: null as { message: string } | null,
  },
}))

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'provider_sources') {
        const chain: Record<string, unknown> = {}
        for (const method of ['select', 'eq']) chain[method] = () => chain
        chain.maybeSingle = () => Promise.resolve(state.source)
        return chain
      }
      return {
        upsert: (values: unknown, options: unknown) => {
          mocks.upsert(table, values, options)
          return Promise.resolve({ error: state.upsertError })
        },
      }
    },
  }),
}))
vi.mock('@/server/pipeline/orchestrator', () => ({ setStatus: mocks.setStatus }))
vi.mock('@/server/services/audit/auditLog', () => ({ appendAudit: mocks.appendAudit }))
vi.mock('@/server/services/alerts/alerts', () => ({ sendAlert: mocks.sendAlert }))
vi.mock('@/server/services/consent/ConsentService', () => ({
  getConsentService: mocks.getConsentService,
  verifyConsent: (_service: unknown, query: unknown) => mocks.verify(query),
}))

import { AppError } from '@/lib/api/errors'
import { consentCheckStage } from '@/server/pipeline/stages/consentCheck'

const record = {
  id: 'rec-1',
  org_id: 'org-1',
  source_id: 'source-1',
  patient_id: 'patient-1',
  doc_type: 'discharge_summary',
  input_kind: 'pdf',
  data_categories: ['DischargeSummary', 'Prescription'],
  status: 'consent_check',
  status_reason: null,
  created_at: '2026-10-07T00:00:00Z',
} as const

const context = { record, job: { id: 'job-1', record_id: 'rec-1', stage: 'consent_check', status: 'running', attempts: 1, max_attempts: 2 } } as never

const verdict = (overrides: Partial<ConsentVerdict>): ConsentVerdict => ({
  result: 'valid',
  matchedScope: [],
  detail: {},
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  state.source = { data: { consent_regime: 'abdm' }, error: null }
  state.upsertError = null
  mocks.getConsentService.mockReturnValue({})
  mocks.appendAudit.mockResolvedValue(undefined)
  mocks.sendAlert.mockResolvedValue(undefined)
  mocks.setStatus.mockResolvedValue(record)
})

describe('consentCheckStage: valid consent', () => {
  it('stores the check, audits it and advances to normalisation', async () => {
    mocks.verify.mockResolvedValue(
      verdict({ result: 'valid', artifactId: 'artifact-1', artifactRef: 'ext-ref-1', matchedScope: ['DischargeSummary', 'Prescription'] }),
    )

    const outcome = await consentCheckStage(context)

    expect(outcome).toEqual({ kind: 'advance' })
    expect(mocks.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        patientId: 'patient-1',
        regime: 'abdm',
        requiredCategories: ['DischargeSummary', 'Prescription'],
        orgId: 'org-1',
      }),
    )
    const [table, saved, options] = mocks.upsert.mock.calls[0] ?? []
    expect(table).toBe('consent_checks')
    expect(saved).toMatchObject({
      record_id: 'rec-1',
      result: 'valid',
      artifact_id: 'artifact-1',
      matched_scope: ['DischargeSummary', 'Prescription'],
      regime: 'abdm',
    })
    expect(options).toEqual({ onConflict: 'record_id' })
    expect(mocks.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'consent.checked', payload: expect.objectContaining({ result: 'valid', artifact_id: 'artifact-1' }) }),
    )
    expect(mocks.setStatus).not.toHaveBeenCalled()
    expect(mocks.sendAlert).not.toHaveBeenCalled()
  })
})

describe('consentCheckStage: hard block (no retry, terminal, nothing further queued)', () => {
  it.each(['missing', 'expired', 'revoked', 'out_of_scope'] as const)('blocks the record on %s', async (result) => {
    mocks.verify.mockResolvedValue(verdict({ result }))

    const outcome = await consentCheckStage(context)

    expect(outcome).toEqual({ kind: 'finished' })
    expect(mocks.setStatus).toHaveBeenCalledWith(record, 'blocked_consent', { reason: result })
    expect(mocks.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'consent.blocked', payload: expect.objectContaining({ reason: result }) }),
    )
    expect(mocks.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'consent_blocked', message: expect.stringContaining('rec-1') }),
    )
    // The recorded decision is the block itself.
    expect(mocks.upsert.mock.calls[0]?.[1]).toMatchObject({ result })
  })

  it('keeps patient data and external consent references out of the alert and the audit payloads', async () => {
    mocks.verify.mockResolvedValue(verdict({ result: 'expired', artifactId: 'artifact-9', artifactRef: 'EXTERNAL-REF-12345' }))
    await consentCheckStage(context)
    const everything = JSON.stringify([mocks.appendAudit.mock.calls, mocks.sendAlert.mock.calls])
    expect(everything).not.toContain('EXTERNAL-REF-12345')
    expect(everything).not.toContain('patient-1')
  })
})

describe('consentCheckStage: ledger errors fail closed', () => {
  it('records the error, does NOT block or advance, and throws a retryable error for the worker', async () => {
    mocks.verify.mockResolvedValue(verdict({ result: 'error', detail: { reason: 'timeout' } }))

    let thrown: unknown
    try {
      await consentCheckStage(context)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).retryable).toBe(true)
    expect((thrown as AppError).code).toBe('UPSTREAM_ERROR')
    expect(mocks.upsert.mock.calls[0]?.[1]).toMatchObject({ result: 'error' })
    expect(mocks.setStatus).not.toHaveBeenCalled()
  })

  it('never proceeds when the ABDM client is selected but unavailable: the error propagates before anything is saved', async () => {
    mocks.getConsentService.mockImplementation(() => {
      throw new AppError('INTERNAL', 'The ABDM consent client is not available in this release.', { retryable: false })
    })
    await expect(consentCheckStage(context)).rejects.toMatchObject({ retryable: false })
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('retries (does not proceed) when saving the check fails', async () => {
    mocks.verify.mockResolvedValue(verdict({ result: 'valid', artifactId: 'a-1' }))
    state.upsertError = { message: 'write failed' }
    await expect(consentCheckStage(context)).rejects.toMatchObject({ retryable: true })
    expect(mocks.appendAudit).not.toHaveBeenCalled()
  })
})

describe('consentCheckStage: unprocessable records', () => {
  it('fails a record without a patient before calling the ledger', async () => {
    const outcome = await consentCheckStage({ ...(context as object), record: { ...record, patient_id: null } } as never)
    expect(outcome).toEqual({ kind: 'fail', reason: 'patient_missing' })
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  it('fails a record whose source no longer exists', async () => {
    state.source = { data: null, error: null }
    const outcome = await consentCheckStage(context)
    expect(outcome).toEqual({ kind: 'fail', reason: 'source_missing' })
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  it('retries when the source cannot be loaded', async () => {
    state.source = { data: null, error: { message: 'db down' } }
    await expect(consentCheckStage(context)).rejects.toMatchObject({ retryable: true })
  })
})
