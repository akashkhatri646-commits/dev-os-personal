import 'server-only'
import { randomUUID } from 'node:crypto'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getEnv } from '@/server/config/env'
import { logger } from '@/server/logger'
import {
  auditJobFailure,
  escalateRecord,
  failRecord,
  loadRecord,
  setStatus,
  type RecordRow,
} from '@/server/pipeline/orchestrator'
import { getBreakerState, PROVIDER_STAGES, recordUpstreamFailure } from '@/server/services/safety/breaker'
import { sweepExpiredReviewLocks } from '@/server/services/review/locks'
import { STAGE_HANDLERS, type StageOutcome } from '@/server/pipeline/stages'
import { NEXT_STAGE, STAGE_STATUS, isTerminal, type JobStage } from '@/server/pipeline/transitions'
import {
  buryJob,
  claimJobs,
  completeJob,
  enqueueJob,
  recordHasJob,
  releaseJob,
  requeueJob,
  type JobRow,
} from '@/server/queue/jobs'

export interface TickSummary {
  claimed: number
  succeeded: number
  retried: number
  escalated: number
  failed: number
  /** Jobs handed back untouched (no handler deployed for the stage, or out of time). */
  released: number
  /** Records found without any job and re-queued. */
  recovered: number
}

export interface TickOptions {
  batchSize: number
  /** Soft budget: no new job starts after this many seconds. */
  maxSeconds: number
  /**
   * Hard time limit of the host running the tick (Netlify: 60 s for a web route). A job started inside the budget
   * may still run for a model call, so the budget is shortened to leave room for it.
   */
  hostLimitSeconds?: number
  /** Longest a single model call may take, in milliseconds. */
  modelTimeoutMs?: number
  workerId?: string
  now?: () => number
}

/** A record stuck in `received` without a job for this long is re-queued (the intake crashed mid-way). */
const ORPHAN_AFTER_MS = 2 * 60 * 1000
const ORPHAN_SWEEP_LIMIT = 20

/** Re-queues the consent check for records the intake created but never queued. */
async function recoverOrphans(): Promise<number> {
  const cutoff = new Date(Date.now() - ORPHAN_AFTER_MS).toISOString()
  const { data, error } = await getSupabaseAdmin()
    .from('ingestion_records')
    .select('id')
    .eq('status', 'received')
    .lt('created_at', cutoff)
    .limit(ORPHAN_SWEEP_LIMIT)
  if (error) throw new AppError('INTERNAL', 'Failed to sweep for orphaned records.', { cause: error })

  let recovered = 0
  for (const row of data ?? []) {
    const recordId = row.id as string
    if (await recordHasJob(recordId)) continue
    await enqueueJob(recordId, 'consent_check')
    recovered += 1
  }
  return recovered
}

/**
 * Handles a stage error: retry once with backoff (attempts are counted at claim time), otherwise
 * bury the job and send the record to review so nothing is ever stranded. A failed consent check
 * fails the record instead, because consent errors must never lead to processing.
 */
export async function handleJobError(job: JobRow, record: RecordRow, error: unknown): Promise<'retried' | 'escalated' | 'failed'> {
  const appError = error instanceof AppError ? error : null
  const retryable = appError ? appError.retryable : false
  const message = appError ? appError.message : 'Unexpected error'
  logger.warn({ job_id: job.id, stage: job.stage, attempts: job.attempts, err: error }, 'stage failed')
  if (appError?.code === 'UPSTREAM_ERROR' && PROVIDER_STAGES.includes(job.stage)) await recordUpstreamFailure(record.org_id, record.id, job.stage)

  if (retryable && job.attempts < job.max_attempts) {
    await requeueJob(job, message)
    return 'retried'
  }

  await buryJob(job.id, message)
  const reason = appError?.code === 'UPSTREAM_ERROR' ? 'llm_error' : `stage_error:${job.stage}`
  await auditJobFailure(record, job.stage, job.attempts, reason)

  if (job.stage === 'consent_check') {
    await failRecord(record, 'consent_service_error')
    return 'failed'
  }
  await escalateRecord(record, reason)
  return 'escalated'
}

async function applyOutcome(job: JobRow, record: RecordRow, outcome: StageOutcome): Promise<'succeeded' | 'escalated' | 'failed' | 'released'> {
  switch (outcome.kind) {
    case 'advance': {
      await completeJob(job.id)
      const next = NEXT_STAGE[job.stage]
      if (next) await enqueueJob(record.id, next)
      return 'succeeded'
    }
    case 'repeat':
      await completeJob(job.id)
      await enqueueJob(record.id, job.stage)
      return 'succeeded'
    case 'finished':
      await completeJob(job.id)
      return 'succeeded'
    case 'escalate':
      await completeJob(job.id)
      if (outcome.taskKind) await escalateRecord(record, outcome.reason, outcome.priority, outcome.taskKind)
      else await escalateRecord(record, outcome.reason, outcome.priority)
      return 'escalated'
    case 'defer':
      await releaseJob(job, outcome.seconds)
      return 'released'
    case 'fail':
      await completeJob(job.id)
      await failRecord(record, outcome.reason)
      return 'failed'
  }
}

async function runJob(job: JobRow): Promise<keyof Omit<TickSummary, 'claimed' | 'recovered'>> {
  const handler = STAGE_HANDLERS[job.stage]
  if (!handler) {
    await releaseJob(job)
    return 'released'
  }

  let record = await loadRecord(job.record_id)
  if (!record || isTerminal(record.status)) {
    // The record was finished or removed while the job waited: nothing left to do.
    await completeJob(job.id)
    return 'succeeded'
  }

  // While the provider keeps failing, its jobs wait untouched (not failed, attempts not used).
  if (PROVIDER_STAGES.includes(job.stage)) {
    const breaker = await getBreakerState()
    if (breaker.open && breaker.retryAt !== null) {
      await releaseJob(job, Math.max(30, Math.ceil((breaker.retryAt - Date.now()) / 1000)))
      return 'released'
    }
  }

  try {
    record = await setStatus(record, STAGE_STATUS[job.stage])
    const outcome = await handler({ record, job })
    return await applyOutcome(job, record, outcome)
  } catch (error) {
    return handleJobError(job, record, error)
  }
}

/**
 * One worker pass: recover orphaned records, claim due jobs and run them one at a time until the
 * time budget is spent. Jobs claimed but not started are released without using an attempt.
 */
export async function runTick(options: TickOptions): Promise<TickSummary> {
  const now = options.now ?? Date.now
  const startWindow = effectiveBudgetSeconds(options)
  const deadline = now() + startWindow * 1000
  const summary: TickSummary = { claimed: 0, succeeded: 0, retried: 0, escalated: 0, failed: 0, released: 0, recovered: 0 }

  summary.recovered = await recoverOrphans()
  await sweepExpiredReviewLocks()

  const workerId = options.workerId ?? `worker-${randomUUID()}`
  // Keep claiming while there is time: finishing a stage queues the next one, and waiting a whole schedule
  // interval between stages would make every record take minutes.
  do {
    const jobs = await claimJobs(options.batchSize, workerId)
    if (jobs.length === 0) break
    summary.claimed += jobs.length

    let progressed = false
    for (const job of jobs) {
      if (now() >= deadline) {
        await releaseJob(job, 0)
        summary.released += 1
        continue
      }
      const result = await runJob(job)
      summary[result] += 1
      if (result !== 'released') progressed = true
    }
    // Only handed-back jobs: claiming again would return the same ones.
    if (!progressed) break
  } while (now() < deadline)
  return summary
}

/** The start window in seconds: the configured budget, shortened so a job started at the end still fits the host limit. */
export function effectiveBudgetSeconds(options: Pick<TickOptions, 'maxSeconds' | 'hostLimitSeconds' | 'modelTimeoutMs'>): number {
  if (!options.hostLimitSeconds) return options.maxSeconds
  const room = options.hostLimitSeconds - Math.ceil((options.modelTimeoutMs ?? 0) / 1000) - HOST_MARGIN_SECONDS
  return Math.max(1, Math.min(options.maxSeconds, room))
}

/** Slack for saving results, queue updates and starting the function. */
const HOST_MARGIN_SECONDS = 5

export function tickOptionsFromEnv(): TickOptions {
  const env = getEnv()
  return {
    batchSize: env.WORKER_BATCH_SIZE,
    maxSeconds: env.WORKER_TICK_MAX_SECONDS,
    hostLimitSeconds: env.WORKER_HOST_LIMIT_SECONDS,
    modelTimeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
  }
}

export type { JobStage }
