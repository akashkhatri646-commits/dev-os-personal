import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { retryDelaySeconds, type JobStage } from '@/server/pipeline/transitions'

const STAGES = ['consent_check', 'normalize', 'extract', 'map', 'validate', 'score', 'route', 'commit'] as const

export const jobRowSchema = z.object({
  id: z.string(),
  record_id: z.string(),
  stage: z.enum(STAGES),
  status: z.enum(['queued', 'running', 'done', 'failed', 'dead']),
  attempts: z.number(),
  max_attempts: z.number(),
})
export type JobRow = z.infer<typeof jobRowSchema>

const UNIQUE_VIOLATION = '23505'

/** Delay before the "no handler yet" release makes a job eligible again. */
const UNHANDLED_RELEASE_SECONDS = 60

/**
 * Queues a stage for a record. At most one queued/running job exists per (record, stage), so
 * enqueueing twice is safe and returns without error.
 */
export async function enqueueJob(
  recordId: string,
  stage: JobStage,
  options: { delaySeconds?: number; maxAttempts?: number } = {},
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from('pipeline_jobs')
    .insert({
      record_id: recordId,
      stage,
      run_at: new Date(Date.now() + (options.delaySeconds ?? 0) * 1000).toISOString(),
      ...(options.maxAttempts ? { max_attempts: options.maxAttempts } : {}),
    })
  if (error && error.code !== UNIQUE_VIOLATION) {
    throw new AppError('INTERNAL', 'Failed to queue the next stage.', { cause: error, retryable: true })
  }
}

/** Claims due jobs with `FOR UPDATE SKIP LOCKED`, recovering jobs whose worker died. */
export async function claimJobs(limit: number, workerId: string): Promise<JobRow[]> {
  const { data, error } = await getSupabaseAdmin().rpc('claim_jobs', { p_limit: limit, p_worker: workerId })
  if (error) throw new AppError('INTERNAL', 'Failed to claim jobs.', { cause: error })
  return z.array(jobRowSchema).parse(data ?? [])
}

/**
 * Gives back jobs left "running" by a pass the host cut off. The database only recovers such jobs after 5 minutes;
 * a job cannot legitimately run longer than the host's time limit, so a short cut-off (limit plus a margin) is safe
 * and gets a stranded record moving again within a minute. Each reclaimed job gets its attempt back. Returns how many.
 */
export async function reclaimStaleJobs(staleAfterSeconds: number): Promise<number> {
  const admin = getSupabaseAdmin()
  const cutoff = new Date(Date.now() - staleAfterSeconds * 1000).toISOString()
  const { data, error } = await admin.from('pipeline_jobs').select('id, attempts').eq('status', 'running').lt('locked_at', cutoff).limit(50)
  if (error) throw new AppError('INTERNAL', 'Failed to look for stranded jobs.', { cause: error, retryable: true })
  for (const row of data ?? []) {
    const { error: updateError } = await admin
      .from('pipeline_jobs')
      .update({
        status: 'queued',
        locked_at: null,
        locked_by: null,
        attempts: Math.max(0, Number(row.attempts) - 1),
        run_at: new Date().toISOString(),
        last_error: 'Reclaimed: the worker pass running it was cut off',
      })
      .eq('id', row.id as string)
      .eq('status', 'running')
    if (updateError) throw new AppError('INTERNAL', 'Failed to reclaim a stranded job.', { cause: updateError, retryable: true })
  }
  return (data ?? []).length
}

export async function completeJob(jobId: string): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from('pipeline_jobs')
    .update({ status: 'done', locked_at: null, locked_by: null, last_error: null })
    .eq('id', jobId)
  if (error) throw new AppError('INTERNAL', 'Failed to complete the job.', { cause: error, retryable: true })
}

/** Puts a failed job back in the queue with linear backoff. */
export async function requeueJob(job: JobRow, errorMessage: string): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from('pipeline_jobs')
    .update({
      status: 'queued',
      locked_at: null,
      locked_by: null,
      last_error: errorMessage.slice(0, 500),
      run_at: new Date(Date.now() + retryDelaySeconds(job.attempts) * 1000).toISOString(),
    })
    .eq('id', job.id)
  if (error) throw new AppError('INTERNAL', 'Failed to requeue the job.', { cause: error })
}

/** Marks a job permanently failed ("dead"); the record is escalated by the caller. */
export async function buryJob(jobId: string, errorMessage: string): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from('pipeline_jobs')
    .update({ status: 'dead', locked_at: null, locked_by: null, last_error: errorMessage.slice(0, 500) })
    .eq('id', jobId)
  if (error) throw new AppError('INTERNAL', 'Failed to mark the job dead.', { cause: error })
}

/**
 * Hands a claimed job back without consuming an attempt: used when the worker ran out of time, or
 * when no handler is deployed for the stage yet.
 */
export async function releaseJob(job: JobRow, delaySeconds = UNHANDLED_RELEASE_SECONDS): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from('pipeline_jobs')
    .update({
      status: 'queued',
      locked_at: null,
      locked_by: null,
      attempts: Math.max(0, job.attempts - 1),
      run_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
    })
    .eq('id', job.id)
  if (error) throw new AppError('INTERNAL', 'Failed to release the job.', { cause: error })
}

/** True when the record has any job, active or finished. */
export async function recordHasJob(recordId: string): Promise<boolean> {
  const { count, error } = await getSupabaseAdmin()
    .from('pipeline_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('record_id', recordId)
  if (error) throw new AppError('INTERNAL', 'Failed to check the record jobs.', { cause: error })
  return (count ?? 0) > 0
}
