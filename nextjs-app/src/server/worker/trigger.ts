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
  void fetch(`${env.APP_BASE_URL}/api/worker/tick`, {
    method: 'POST',
    headers: { [WORKER_SECRET_HEADER]: env.WORKER_SECRET },
    signal: AbortSignal.timeout(2000),
  }).catch((error: unknown) => logger.debug({ err: error }, 'worker nudge failed'))
}
