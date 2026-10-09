// Netlify scheduled function: every minute, starts a worker pass by calling the app's tick route. This is the safety
// net behind the immediate start that happens when a record is queued. Scheduled functions stop after 30 s, so this
// only waits a short while: the pass keeps running on its own, and a pass that runs out of time starts the next one.
// Environment (set in the Netlify UI, scope: Functions): APP_BASE_URL and WORKER_SECRET.
import type { Config } from '@netlify/functions'

const WAIT_MS = 25_000

export default async () => {
  const baseUrl = process.env.APP_BASE_URL
  const secret = process.env.WORKER_SECRET
  if (!baseUrl || !secret) {
    console.error('worker-tick: APP_BASE_URL or WORKER_SECRET is not set')
    return
  }

  try {
    const response = await fetch(`${baseUrl}/api/worker/tick`, {
      method: 'POST',
      headers: { 'x-worker-secret': secret },
      signal: AbortSignal.timeout(WAIT_MS),
    })
    if (response.status === 401) console.error('worker-tick: the tick route refused the secret; WORKER_SECRET differs between the function and the app')
    else if (!response.ok) console.error(`worker-tick: tick responded with ${response.status}`)
    else console.log(`worker-tick: ${await response.text()}`)
  } catch (error) {
    // Waiting ran out: the pass was sent and is still running, which is normal while jobs are being processed.
    console.log('worker-tick: pass started, still running after', WAIT_MS / 1000, 's', error instanceof Error ? error.name : '')
  }
}

export const config: Config = { schedule: '* * * * *' }
