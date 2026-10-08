// Netlify background function (runs up to 15 minutes, answers 202 at once). Started every minute by `worker-tick`.
// It calls the worker route repeatedly for up to a minute, so a record moves through several stages without
// waiting for the next schedule. Each call to the route stays inside Netlify's 60 s limit (see
// WORKER_HOST_LIMIT_SECONDS); calls that overlap with the next minute's run are safe because jobs are claimed with locks.
// Environment (set in the Netlify UI, scope: Functions): APP_BASE_URL and WORKER_SECRET.
import type { Config } from '@netlify/functions'

const RUN_FOR_MS = 55_000
const PAUSE_MS = 1_000

export default async (req: Request) => {
  const baseUrl = process.env.APP_BASE_URL
  const secret = process.env.WORKER_SECRET
  if (!baseUrl || !secret) {
    console.error('worker-run: APP_BASE_URL or WORKER_SECRET is not set')
    return
  }
  // The function can be called by URL: only the scheduler, which holds the secret, may start it.
  if (req.headers.get('x-worker-secret') !== secret) {
    console.error('worker-run: refused a call without the worker secret')
    return
  }

  const stopAt = Date.now() + RUN_FOR_MS
  while (Date.now() < stopAt) {
    let claimed = 0
    try {
      const response = await fetch(`${baseUrl}/api/worker/tick`, { method: 'POST', headers: { 'x-worker-secret': secret }, signal: AbortSignal.timeout(65_000) })
      if (!response.ok) {
        console.error(`worker-run: tick responded with ${response.status}`)
        return
      }
      const body = (await response.json()) as { data?: { claimed?: number } }
      claimed = body.data?.claimed ?? 0
    } catch (error) {
      console.error('worker-run: tick failed', error instanceof Error ? error.message : error)
      return
    }
    // Nothing was waiting: stop and let the next schedule look again.
    if (claimed === 0) return
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS))
  }
}

export const config: Config = { background: true, path: '/.netlify/functions/worker-run' }
