// Pipeline-level guarantee: a record whose consent is not valid is stopped by the real
// consent stage, and no later stage is ever queued or run for it.
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const { jobs, orchestrator, consent, other } = vi.hoisted(() => ({
  jobs: {
    claimJobs: vi.fn(),
    reclaimStaleJobs: vi.fn().mockResolvedValue(0),
    completeJob: vi.fn(),
    enqueueJob: vi.fn(),
    recordHasJob: vi.fn(),
    releaseJob: vi.fn(),
    requeueJob: vi.fn(),
    buryJob: vi.fn(),
  },
  orchestrator: {
    auditJobFailure: vi.fn(),
    escalateRecord: vi.fn(),
    failRecord: vi.fn(),
    loadRecord: vi.fn(),
    setStatus: vi.fn(),
  },
  consent: { verify: vi.fn(), getConsentService: vi.fn() },
  other: { appendAudit: vi.fn(), sendAlert: vi.fn() },
}))

vi.mock('@/server/queue/jobs', () => jobs)
vi.mock('@/server/pipeline/orchestrator', () => orchestrator)
vi.mock('@/server/services/consent/ConsentService', () => ({
  getConsentService: consent.getConsentService,
  verifyConsent: (_service: unknown, query: unknown) => consent.verify(query),
}))
vi.mock('@/server/services/audit/auditLog', () => ({ appendAudit: other.appendAudit }))
vi.mock('@/server/services/alerts/alerts', () => ({ sendAlert: other.sendAlert }))
vi.mock('@/server/config/env', () => ({ getEnv: () => ({ WORKER_BATCH_SIZE: 5, WORKER_TICK_MAX_SECONDS: 50 }) }))
vi.mock('@/server/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'lt', 'limit']) chain[method] = () => chain
      chain.maybeSingle = () => Promise.resolve({ data: { consent_regime: 'abdm' }, error: null })
      chain.upsert = () => Promise.resolve({ error: null })
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
      void table
      return chain
    },
  }),
}))

import { AppError } from '@/lib/api/errors'
import { STAGE_HANDLERS, type StageHandler } from '@/server/pipeline/stages'
import { runTick } from '@/server/worker/tick'

const record = (overrides: Record<string, unknown> = {}) => ({
  id: 'rec-1',
  org_id: 'org-1',
  source_id: 'source-1',
  patient_id: 'patient-1',
  doc_type: 'discharge_summary',
  input_kind: 'pdf',
  data_categories: ['DischargeSummary'],
  status: 'received',
  status_reason: null,
  created_at: '2026-10-07T00:00:00Z',
  ...overrides,
})
const consentJob = { id: 'job-1', record_id: 'rec-1', stage: 'consent_check', status: 'running', attempts: 1, max_attempts: 2 }
const options = { batchSize: 5, maxSeconds: 50, workerId: 'w' }

let normalizeHandler: Mock<StageHandler>

beforeEach(() => {
  vi.clearAllMocks()
  normalizeHandler = vi.fn<StageHandler>().mockResolvedValue({ kind: 'advance' })
  STAGE_HANDLERS.normalize = normalizeHandler
  orchestrator.loadRecord.mockResolvedValue(record())
  orchestrator.setStatus.mockImplementation(async (rec: object, status: string) => ({ ...rec, status }))
  jobs.claimJobs.mockReset().mockResolvedValue([]).mockResolvedValueOnce([consentJob])
  consent.getConsentService.mockReturnValue({})
  other.appendAudit.mockResolvedValue(undefined)
  other.sendAlert.mockResolvedValue(undefined)
})

describe('consent gate inside the worker', () => {
  it('queues normalisation only after a valid consent', async () => {
    consent.verify.mockResolvedValue({ result: 'valid', artifactId: 'a-1', matchedScope: ['DischargeSummary'], detail: {} })
    const summary = await runTick(options)
    expect(summary.succeeded).toBe(1)
    expect(jobs.enqueueJob).toHaveBeenCalledWith('rec-1', 'normalize')
    expect(orchestrator.setStatus).toHaveBeenCalledWith(expect.anything(), 'consent_check')
  })

  it.each(['missing', 'expired', 'revoked', 'out_of_scope'])('%s: blocks the record and queues nothing', async (result) => {
    consent.verify.mockResolvedValue({ result, matchedScope: [], detail: {} })
    const summary = await runTick(options)

    expect(summary.succeeded).toBe(1) // the job itself completed: the block is a final outcome, not a failure
    expect(orchestrator.setStatus).toHaveBeenCalledWith(expect.anything(), 'blocked_consent', { reason: result })
    expect(jobs.enqueueJob).not.toHaveBeenCalled()
    expect(normalizeHandler).not.toHaveBeenCalled()
    expect(jobs.requeueJob).not.toHaveBeenCalled()
    expect(jobs.buryJob).not.toHaveBeenCalled()
  })

  it('retries once on a ledger error and queues nothing meanwhile', async () => {
    consent.verify.mockResolvedValue({ result: 'error', matchedScope: [], detail: { reason: 'timeout' } })
    const summary = await runTick(options)
    expect(summary.retried).toBe(1)
    expect(jobs.requeueJob).toHaveBeenCalledTimes(1)
    expect(jobs.enqueueJob).not.toHaveBeenCalled()
    expect(normalizeHandler).not.toHaveBeenCalled()
  })

  it('fails the record when the ledger is still down on the last attempt (outage never becomes processing)', async () => {
    jobs.claimJobs.mockReset().mockResolvedValue([]).mockResolvedValueOnce([{ ...consentJob, attempts: 2 }])
    consent.verify.mockResolvedValue({ result: 'error', matchedScope: [], detail: { reason: 'timeout' } })
    const summary = await runTick(options)
    expect(summary.failed).toBe(1)
    expect(orchestrator.failRecord).toHaveBeenCalledWith(expect.anything(), 'consent_service_error')
    expect(jobs.enqueueJob).not.toHaveBeenCalled()
    expect(normalizeHandler).not.toHaveBeenCalled()
  })

  it('fails the record at once when the selected ledger is unavailable (ABDM client not shipped)', async () => {
    consent.getConsentService.mockImplementation(() => {
      throw new AppError('INTERNAL', 'The ABDM consent client is not available in this release.', { retryable: false })
    })
    const summary = await runTick(options)
    expect(summary.failed).toBe(1)
    expect(orchestrator.failRecord).toHaveBeenCalledWith(expect.anything(), 'consent_service_error')
    expect(jobs.requeueJob).not.toHaveBeenCalled()
    expect(normalizeHandler).not.toHaveBeenCalled()
  })
})
