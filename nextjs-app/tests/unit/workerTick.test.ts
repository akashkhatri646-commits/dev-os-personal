import { beforeEach, describe, expect, it, vi } from 'vitest'

const { jobs, orchestrator } = vi.hoisted(() => ({
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
}))

vi.mock('@/server/queue/jobs', () => jobs)
vi.mock('@/server/pipeline/orchestrator', () => orchestrator)
vi.mock('@/server/config/env', () => ({ getEnv: () => ({ WORKER_BATCH_SIZE: 5, WORKER_TICK_MAX_SECONDS: 50 }) }))
vi.mock('@/server/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/supabase/admin', () => ({
  // recoverOrphans: select(...).eq().lt().limit() resolves to a list of orphan ids.
  getSupabaseAdmin: () => ({
    from: () => {
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'lt', 'limit']) chain[method] = () => chain
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(orphanResult()).then(resolve)
      return chain
    },
  }),
}))

let orphanResult: () => { data: { id: string }[]; error: null } = () => ({ data: [], error: null })

import { AppError } from '@/lib/api/errors'
import { STAGE_HANDLERS } from '@/server/pipeline/stages'
import { handleJobError, runTick } from '@/server/worker/tick'

const job = (overrides: Record<string, unknown> = {}) => ({
  id: 'job-1',
  record_id: 'rec-1',
  stage: 'consent_check',
  status: 'running',
  attempts: 1,
  max_attempts: 2,
  ...overrides,
})

const record = (overrides: Record<string, unknown> = {}) => ({
  id: 'rec-1',
  org_id: 'org-1',
  source_id: 's-1',
  patient_id: 'p-1',
  doc_type: 'discharge_summary',
  input_kind: 'pdf',
  data_categories: ['DischargeSummary'],
  status: 'received',
  status_reason: null,
  created_at: '2026-10-07T00:00:00Z',
  ...overrides,
})

const options = { batchSize: 5, maxSeconds: 50, workerId: 'test-worker' }

beforeEach(() => {
  vi.clearAllMocks()
  orphanResult = () => ({ data: [], error: null })
  for (const stage of Object.keys(STAGE_HANDLERS)) delete STAGE_HANDLERS[stage as keyof typeof STAGE_HANDLERS]
  orchestrator.loadRecord.mockResolvedValue(record())
  orchestrator.setStatus.mockImplementation(async (rec: unknown, status: string) => ({ ...(rec as object), status }))
  jobs.claimJobs.mockReset().mockResolvedValue([])
})

describe('runTick', () => {
  it('releases a job untouched when no handler is deployed for its stage', async () => {
    jobs.claimJobs.mockResolvedValueOnce([job()])
    const summary = await runTick(options)
    expect(jobs.releaseJob).toHaveBeenCalledTimes(1)
    expect(jobs.completeJob).not.toHaveBeenCalled()
    expect(orchestrator.setStatus).not.toHaveBeenCalled()
    expect(summary).toMatchObject({ claimed: 1, released: 1, succeeded: 0 })
  })

  it('sets the in-progress status, completes the job and queues the next stage on advance', async () => {
    const handler = vi.fn().mockResolvedValue({ kind: 'advance' })
    STAGE_HANDLERS.consent_check = handler
    jobs.claimJobs.mockResolvedValueOnce([job()])

    const summary = await runTick(options)

    expect(orchestrator.setStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 'rec-1' }), 'consent_check')
    expect(handler).toHaveBeenCalledTimes(1)
    expect(jobs.completeJob).toHaveBeenCalledWith('job-1')
    expect(jobs.enqueueJob).toHaveBeenCalledWith('rec-1', 'normalize')
    expect(summary.succeeded).toBe(1)
  })

  it('queues nothing after the last stage or a finished outcome', async () => {
    STAGE_HANDLERS.commit = vi.fn().mockResolvedValue({ kind: 'advance' })
    jobs.claimJobs.mockResolvedValueOnce([job({ stage: 'commit' })])
    await runTick(options)
    expect(jobs.enqueueJob).not.toHaveBeenCalled()

    STAGE_HANDLERS.normalize = vi.fn().mockResolvedValue({ kind: 'finished' })
    jobs.claimJobs.mockResolvedValueOnce([job({ id: 'job-2', stage: 'normalize' })])
    await runTick(options)
    expect(jobs.enqueueJob).not.toHaveBeenCalled()
    expect(jobs.completeJob).toHaveBeenCalledWith('job-2')
  })

  it('re-queues the same stage on a repeat outcome (chunked work)', async () => {
    STAGE_HANDLERS.extract = vi.fn().mockResolvedValue({ kind: 'repeat' })
    jobs.claimJobs.mockResolvedValueOnce([job({ stage: 'extract' })])
    await runTick(options)
    expect(jobs.enqueueJob).toHaveBeenCalledWith('rec-1', 'extract')
  })

  it('escalates or fails the record on those outcomes', async () => {
    STAGE_HANDLERS.normalize = vi.fn().mockResolvedValue({ kind: 'escalate', reason: 'low_ocr_quality' })
    jobs.claimJobs.mockResolvedValueOnce([job({ stage: 'normalize' })])
    expect((await runTick(options)).escalated).toBe(1)
    expect(orchestrator.escalateRecord).toHaveBeenCalledWith(expect.anything(), 'low_ocr_quality', undefined)

    STAGE_HANDLERS.consent_check = vi.fn().mockResolvedValue({ kind: 'fail', reason: 'consent_service_error' })
    jobs.claimJobs.mockResolvedValueOnce([job({ id: 'job-3' })])
    expect((await runTick(options)).failed).toBe(1)
    expect(orchestrator.failRecord).toHaveBeenCalledWith(expect.anything(), 'consent_service_error')
  })

  it('passes the stage-supplied priority to the review task', async () => {
    STAGE_HANDLERS.normalize = vi.fn().mockResolvedValue({ kind: 'escalate', reason: 'low_ocr_quality', priority: 75 })
    jobs.claimJobs.mockResolvedValueOnce([job({ stage: 'normalize' })])
    await runTick(options)
    expect(orchestrator.escalateRecord).toHaveBeenCalledWith(expect.anything(), 'low_ocr_quality', 75)
  })

  it('completes the job without running the handler when the record is already terminal', async () => {
    const handler = vi.fn()
    STAGE_HANDLERS.consent_check = handler
    orchestrator.loadRecord.mockResolvedValue(record({ status: 'blocked_consent' }))
    jobs.claimJobs.mockResolvedValueOnce([job()])
    await runTick(options)
    expect(handler).not.toHaveBeenCalled()
    expect(jobs.completeJob).toHaveBeenCalledWith('job-1')
  })

  it('handles a deleted record the same way', async () => {
    STAGE_HANDLERS.consent_check = vi.fn()
    orchestrator.loadRecord.mockResolvedValue(null)
    jobs.claimJobs.mockResolvedValueOnce([job()])
    await runTick(options)
    expect(jobs.completeJob).toHaveBeenCalledWith('job-1')
  })

  it('hands back claimed jobs it has no time to start, without using an attempt', async () => {
    const handler = vi.fn().mockResolvedValue({ kind: 'advance' })
    STAGE_HANDLERS.consent_check = handler
    jobs.claimJobs.mockResolvedValueOnce([job(), job({ id: 'job-2' })])
    let calls = 0
    // First check is inside the budget, every later one is past the deadline.
    const now = () => (calls++ === 0 ? 0 : 1_000_000)
    const summary = await runTick({ ...options, now })
    expect(handler).not.toHaveBeenCalled()
    expect(jobs.releaseJob).toHaveBeenCalledTimes(2)
    expect(jobs.releaseJob).toHaveBeenCalledWith(expect.anything(), 0)
    expect(summary.released).toBe(2)
  })

  it('says another pass should follow when time ran out after real work, and not when the queue is empty', async () => {
    STAGE_HANDLERS.consent_check = vi.fn().mockResolvedValue({ kind: 'advance' })
    jobs.claimJobs.mockResolvedValueOnce([job()])
    // Inside the budget when the job starts, past it afterwards.
    let calls = 0
    const now = () => (calls++ < 2 ? 0 : 1_000_000)
    expect((await runTick({ ...options, now })).more).toBe(true)

    jobs.claimJobs.mockReset().mockResolvedValue([])
    expect((await runTick(options)).more).toBe(false)
  })

  it('re-queues records that were created but never queued', async () => {
    orphanResult = () => ({ data: [{ id: 'orphan-1' }, { id: 'orphan-2' }], error: null })
    jobs.recordHasJob.mockImplementation(async (id: string) => id === 'orphan-2')
    const summary = await runTick(options)
    expect(jobs.enqueueJob).toHaveBeenCalledTimes(1)
    expect(jobs.enqueueJob).toHaveBeenCalledWith('orphan-1', 'consent_check')
    expect(summary.recovered).toBe(1)
  })
})

describe('handleJobError (retry once, then escalate)', () => {
  it('re-queues a retryable error while attempts remain', async () => {
    const error = new AppError('UPSTREAM_ERROR', 'provider timeout')
    const result = await handleJobError(job({ stage: 'extract', attempts: 1 }) as never, record() as never, error)
    expect(result).toBe('retried')
    expect(jobs.requeueJob).toHaveBeenCalledTimes(1)
    expect(jobs.buryJob).not.toHaveBeenCalled()
  })

  it('buries the job and sends the record to review once attempts are used up', async () => {
    const error = new AppError('UPSTREAM_ERROR', 'provider timeout')
    const result = await handleJobError(job({ stage: 'extract', attempts: 2 }) as never, record() as never, error)
    expect(result).toBe('escalated')
    expect(jobs.buryJob).toHaveBeenCalledWith('job-1', 'provider timeout')
    expect(orchestrator.auditJobFailure).toHaveBeenCalledWith(expect.anything(), 'extract', 2, 'llm_error')
    expect(orchestrator.escalateRecord).toHaveBeenCalledWith(expect.anything(), 'llm_error')
  })

  it('escalates non-retryable and unexpected errors immediately with a stage reason', async () => {
    const result = await handleJobError(
      job({ stage: 'map', attempts: 1 }) as never,
      record() as never,
      new Error('boom with secret details'),
    )
    expect(result).toBe('escalated')
    expect(orchestrator.escalateRecord).toHaveBeenCalledWith(expect.anything(), 'stage_error:map')
    // Unexpected error text is never stored on the job.
    expect(jobs.buryJob).toHaveBeenCalledWith('job-1', 'Unexpected error')
  })

  it('fails the record instead of escalating when the consent check cannot complete', async () => {
    const result = await handleJobError(
      job({ stage: 'consent_check', attempts: 2 }) as never,
      record() as never,
      new AppError('UPSTREAM_ERROR', 'ledger down'),
    )
    expect(result).toBe('failed')
    expect(orchestrator.failRecord).toHaveBeenCalledWith(expect.anything(), 'consent_service_error')
    expect(orchestrator.escalateRecord).not.toHaveBeenCalled()
  })
})

describe('effectiveBudgetSeconds', () => {
  it('keeps the configured budget when the host has no limit', async () => {
    const { effectiveBudgetSeconds } = await import('@/server/worker/tick')
    expect(effectiveBudgetSeconds({ maxSeconds: 50 })).toBe(50)
  })

  it('never goes past the host limit less a safety margin', async () => {
    const { effectiveBudgetSeconds } = await import('@/server/worker/tick')
    expect(effectiveBudgetSeconds({ maxSeconds: 50, hostLimitSeconds: 26 })).toBe(18)
    expect(effectiveBudgetSeconds({ maxSeconds: 90, hostLimitSeconds: 60 })).toBe(52)
    expect(effectiveBudgetSeconds({ maxSeconds: 10, hostLimitSeconds: 26 })).toBe(10)
  })
})

describe('the host limit the worker plans for', () => {
  it('assumes the Free-plan limit on a hosted site unless a longer one has been confirmed', async () => {
    const { plannedHostLimitSeconds } = await import('@/server/worker/tick')
    expect(plannedHostLimitSeconds(undefined, false, false)).toBeUndefined()
    expect(plannedHostLimitSeconds(undefined, false, true)).toBe(26)
    expect(plannedHostLimitSeconds(60, false, true)).toBe(26)
    expect(plannedHostLimitSeconds(60, true, true)).toBe(60)
    expect(plannedHostLimitSeconds(15, false, true)).toBe(15)
  })
})

describe('time reserved per stage on a host with a hard limit', () => {
  const hosted = { ...options, maxSeconds: 50, hostLimitSeconds: 26, modelTimeoutMs: 20_000 }
  /** 0 ms on the first reading (the start of the pass), 5 s on every later one. */
  const clockAt5s = () => {
    let calls = 0
    return () => (calls++ === 0 ? 0 : 5_000)
  }

  it('reserves the model timeout for a model stage, a little for reading a document, and nothing for quick stages', async () => {
    const { stageReserveSeconds } = await import('@/server/worker/tick')
    expect(stageReserveSeconds('extract', 20_000)).toBe(23)
    expect(stageReserveSeconds('map', 20_000)).toBe(23)
    expect(stageReserveSeconds('normalize', 20_000)).toBe(10)
    for (const stage of ['consent_check', 'validate', 'score', 'route', 'commit'] as const) expect(stageReserveSeconds(stage, 20_000)).toBe(0)
  })

  it('starts quick stages late in a pass, but holds back a model stage that could not finish, and asks for another pass', async () => {
    const light = vi.fn().mockResolvedValue({ kind: 'advance' })
    const model = vi.fn().mockResolvedValue({ kind: 'advance' })
    STAGE_HANDLERS.consent_check = light
    STAGE_HANDLERS.extract = model
    jobs.claimJobs.mockResolvedValueOnce([job(), job({ id: 'job-2', stage: 'extract' })])
    const summary = await runTick({ ...hosted, now: clockAt5s() })
    expect(light).toHaveBeenCalledTimes(1)
    expect(model).not.toHaveBeenCalled()
    expect(jobs.releaseJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-2' }), 0)
    expect(summary).toMatchObject({ succeeded: 1, released: 1, more: true })
  })

  it('starts the first job of a pass even when its reserve does not fit, so a pass can never be empty', async () => {
    const model = vi.fn().mockResolvedValue({ kind: 'advance' })
    STAGE_HANDLERS.map = model
    jobs.claimJobs.mockResolvedValueOnce([job({ stage: 'map' })])
    const summary = await runTick({ ...hosted, modelTimeoutMs: 120_000 })
    expect(model).toHaveBeenCalledTimes(1)
    expect(summary.released).toBe(0)
  })

  it('hands back jobs a cut-off pass left running before it claims new ones', async () => {
    jobs.reclaimStaleJobs.mockResolvedValueOnce(1)
    await runTick(hosted)
    expect(jobs.reclaimStaleJobs).toHaveBeenCalledWith(36)
  })

  it('does not look for stranded jobs when there is no host limit (local development)', async () => {
    await runTick(options)
    expect(jobs.reclaimStaleJobs).not.toHaveBeenCalled()
  })
})
