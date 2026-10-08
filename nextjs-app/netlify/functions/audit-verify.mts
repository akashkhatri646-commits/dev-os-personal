// Netlify scheduled function: daily audit-chain integrity check (03:00 UTC).
// Environment (set in the Netlify UI): APP_BASE_URL and WORKER_SECRET.
export default async () => {
  const baseUrl = process.env.APP_BASE_URL
  const secret = process.env.WORKER_SECRET
  if (!baseUrl || !secret) {
    console.error('audit-verify: APP_BASE_URL or WORKER_SECRET is not set')
    return
  }

  const response = await fetch(`${baseUrl}/api/internal/audit/verify`, {
    method: 'POST',
    headers: { 'x-worker-secret': secret },
  })
  if (!response.ok) console.error(`audit-verify: responded with ${response.status}`)
}

export const config = { schedule: '0 3 * * *' }
