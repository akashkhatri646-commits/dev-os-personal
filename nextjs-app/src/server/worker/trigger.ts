import 'server-only'
import { getEnv } from '@/server/config/env'
import { logger } from '@/server/logger'
import { WORKER_SECRET_HEADER } from '@/server/worker/auth'

/**
 * Nudges the worker right after new work is queued, to cut latency. Fire-and-forget: the scheduled
 * tick is the guarantee, this is only an optimisation, so every failure is ignored.
 */
export function triggerWorkerTick(): void {
  const env = getEnv()
  if (!env.WORKER_SECRET) return
  // Hosted: start the background worker, which answers at once and then keeps the record moving through its stages
  // for up to a minute. Starting the web route instead would be cut off when this request ends, and a single pass
  // there only does about 20 seconds of work. Local development calls the route directly.
  const hosted = !/localhost|127\.0\.0\.1/.test(env.APP_BASE_URL)
  const path = hosted ? '/.netlify/functions/worker-run' : '/api/worker/tick'
  void fetch(`${env.APP_BASE_URL}${path}`, {
    method: 'POST',
    headers: { [WORKER_SECRET_HEADER]: env.WORKER_SECRET },
    signal: AbortSignal.timeout(2000),
  }).catch((error: unknown) => logger.debug({ err: error }, 'worker nudge failed'))
}
