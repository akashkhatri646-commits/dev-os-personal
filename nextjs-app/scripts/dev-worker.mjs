// Local stand-in for the Netlify scheduler: calls the worker every few seconds while you develop.
// Run in a second terminal next to `npm run dev`:   npm run worker:dev
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const values = {}
for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (match) values[match[1]] = match[2].split('#')[0].trim()
}
const base = values.APP_BASE_URL || 'http://localhost:3000'
const secret = values.WORKER_SECRET
if (!secret) {
  console.error('WORKER_SECRET is not set in .env.local')
  process.exit(1)
}

const everyMs = Number(process.argv[2] ?? 5) * 1000
console.log(`Calling ${base}/api/worker/tick every ${everyMs / 1000}s. Press Ctrl+C to stop.`)
let busy = false
setInterval(async () => {
  if (busy) return
  busy = true
  try {
    const response = await fetch(`${base}/api/worker/tick`, { method: 'POST', headers: { 'x-worker-secret': secret }, signal: AbortSignal.timeout(120_000) })
    const body = await response.json().catch(() => null)
    const summary = body?.data
    if (!response.ok) console.log(new Date().toLocaleTimeString(), 'tick failed:', response.status, body?.error?.message ?? '')
    else if (summary && (summary.claimed > 0 || summary.recovered > 0)) console.log(new Date().toLocaleTimeString(), JSON.stringify(summary))
  } catch (error) {
    console.log(new Date().toLocaleTimeString(), 'tick error:', error instanceof Error ? error.message : String(error))
  } finally {
    busy = false
  }
}, everyMs)
