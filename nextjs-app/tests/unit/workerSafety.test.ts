import { beforeEach, describe, expect, it, vi } from 'vitest'

const { jobs, orchestrator, breaker } = vi.hoisted(() => ({
  jobs: {
    claimJobs: vi.fn(),
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
  breaker: { getBreakerState: vi.fn(), recordUpstreamFailure: vi.fn() },
}))

vi.mock('@/server/queue/jobs', () => jobs)
vi.mock('@/server/pipeline/orchestrator', () => orchestrator)
vi.mock('@/server/services/safety/breaker', () => ({
  PROVIDER_STAGES: ['normalize', 'extract', 'map'],
  getBreakerState: breaker.getBreakerState,
  recordUpstreamFailure: breaker.recordUpstreamFailure,
}))
vi.mock('@/server/services/review/locks', () => ({ sweepExpiredReviewLocks: async () => 0 }))
vi.mock('@/server/config/env', () => ({ getEnv: () => ({}) }))
vi.mock('@/server/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: () => {
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'lt', 'limit']) chain[method] = () => chain
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
      return chain
    },
  }),
}))

import { AppError } from '@/lib/api/errors'
import { STAGE_HANDLERS } from '@/server/pipeline/stages'
import { handleJobError, runTick } from '@/server/worker/tick'

const job = (overrides: Record<string, unknown> = {}) => ({ id: 'job-1', record_id: 'rec-1', stage: 'extract', status: 'running', attempts: 1, max_attempts: 3, ...overrides })
const record = { id: 'rec-1', org_id: 'org-1', source_id: 's-1', patient_id: 'p-1', doc_type: 'discharge_summary', input_kind: 'pdf', data_categories: ['DischargeSummary'], status: 'extracting', status_reason: null, created_at: '2026-10-07T00:00:00Z' }
const options = { batchSize: 5, maxSeconds: 50, workerId: 'test-worker' }

beforeEach(() => {
  vi.clearAllMocks()
  for (const stage of Object.keys(STAGE_HANDLERS)) delete STAGE_HANDLERS[stage as keyof typeof STAGE_HANDLERS]
  orchestrator.loadRecord.mockResolvedValue(record)
  orchestrator.setStatus.mockImplementation(async (rec: unknown, status: string) => ({ ...(rec as object), status }))
  jobs.claimJobs.mockResolvedValue([job()])
  breaker.getBreakerState.mockResolvedValue({ open: false, retryAt: null })
})

describe('circuit breaker in the worker', () => {
  it('holds provider jobs back, untouched, while the breaker is open', async () => {
    breaker.getBreakerState.mockResolvedValue({ open: true, retryAt: Date.now() + 200_000 })
    const handler = vi.fn()
    STAGE_HANDLERS.extract = handler
    const summary = await runTick(options)
    expect(handler).not.toHaveBeenCalled()
    expect(jobs.releaseJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }), expect.any(Number))
    const delay = jobs.releaseJob.mock.calls[0]?.[1] as number
    expect(delay).toBeGreaterThan(150)
    expect(jobs.buryJob).not.toHaveBeenCalled()
    expect(orchestrator.escalateRecord).not.toHaveBeenCalled()
    expect(summary.released).toBe(1)
  })

  it('does not hold back stages that use no provider', async () => {
    breaker.getBreakerState.mockResolvedValue({ open: true, retryAt: Date.now() + 200_000 })
    const handler = vi.fn().mockResolvedValue({ kind: 'advance' })
    STAGE_HANDLERS.score = handler
    jobs.claimJobs.mockResolvedValueOnce([job({ stage: 'score' })]).mockResolvedValue([])
    await runTick(options)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('counts a failed provider call, but not a failure of another stage', async () => {
    const failure = new AppError('UPSTREAM_ERROR', 'provider down', { retryable: true })
    await handleJobError(job() as never, record as never, failure)
    expect(breaker.recordUpstreamFailure).toHaveBeenCalledWith('org-1', 'rec-1', 'extract')
    await handleJobError(job({ stage: 'consent_check' }) as never, record as never, failure)
    expect(breaker.recordUpstreamFailure).toHaveBeenCalledTimes(1)
  })
})

describe('deferred jobs', () => {
  it('puts a deferred job back for later without using an attempt or touching the record', async () => {
    STAGE_HANDLERS.extract = vi.fn().mockResolvedValue({ kind: 'defer', seconds: 900 })
    const summary = await runTick(options)
    expect(jobs.releaseJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }), 900)
    expect(jobs.completeJob).not.toHaveBeenCalled()
    expect(jobs.enqueueJob).not.toHaveBeenCalled()
    expect(orchestrator.escalateRecord).not.toHaveBeenCalled()
    expect(summary.released).toBe(1)
  })
})
