// Netlify scheduled function: every minute, starts the background worker. Scheduled functions stop after 30 s,
// so this only hands over to `worker-run` (a background function) and returns.
// Environment (set in the Netlify UI, scope: Functions): APP_BASE_URL and WORKER_SECRET.
import type { Config } from '@netlify/functions'

export default async () => {
  const baseUrl = process.env.APP_BASE_URL
  const secret = process.env.WORKER_SECRET
  if (!baseUrl || !secret) {
    console.error('worker-tick: APP_BASE_URL or WORKER_SECRET is not set')
    return
  }

  try {
    const response = await fetch(`${baseUrl}/.netlify/functions/worker-run`, {
      method: 'POST',
      headers: { 'x-worker-secret': secret },
      signal: AbortSignal.timeout(20_000),
    })
    // A background function answers 202 as soon as it is queued.
    if (response.status !== 202) console.error(`worker-tick: worker-run responded with ${response.status}`)
  } catch (error) {
    console.error('worker-tick: could not start worker-run', error instanceof Error ? error.message : error)
  }
}

export const config: Config = { schedule: '* * * * *' }
