import 'server-only'
import { getEnv } from '@/server/config/env'
import { logger } from '@/server/logger'
import { WORKER_SECRET_HEADER } from '@/server/worker/auth'

/** How long to wait for the request to be accepted. The pass itself keeps running after we stop waiting. */
const SEND_TIMEOUT_MS = 1500

/**
 * Starts a worker pass by calling the tick route, and waits just long enough for the request to be sent. A hosted
 * function can be frozen the moment its response returns, which would lose a request that was only started, so
 * callers await this. The pass is not cancelled when we stop waiting: it runs to completion on its own.
 *
 * Used right after work is queued (to cut latency) and by a pass that ran out of time with work left (to carry on at
 * once). The scheduled call is the safety net, so every failure here is ignored.
 */
export async function triggerWorkerTick(): Promise<void> {
  const env = getEnv()
  if (!env.WORKER_SECRET) return
  try {
    await fetch(`${env.APP_BASE_URL}/api/worker/tick`, {
      method: 'POST',
      headers: { [WORKER_SECRET_HEADER]: env.WORKER_SECRET },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
  } catch (error) {
    // A timeout is the normal case: the request was sent and the pass is running.
    logger.debug({ err: error }, 'worker nudge sent or failed')
  }
}
