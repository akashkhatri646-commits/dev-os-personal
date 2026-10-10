import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 90

const SECONDS = 75

function authorised(request: NextRequest): boolean {
  const expected = process.env.WORKER_SECRET
  const provided = request.headers.get('x-worker-secret')
  if (!expected || !provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Finds out how long a web function may run on this host. Streams one line a second for 75 seconds; the number on the
 * last line received before the connection drops is the limit. Run it once with `curl -N`. Needs WORKER_SECRET.
 */
export async function GET(request: NextRequest) {
  if (!authorised(request)) return NextResponse.json({ error: 'Not authorised.' }, { status: 401 })
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      for (let second = 1; second <= SECONDS; second += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        controller.enqueue(encoder.encode(`alive after ${second} s\n`))
      }
      controller.enqueue(encoder.encode(`finished: this host allowed at least ${SECONDS} s\n`))
      controller.close()
    },
  })
  return new NextResponse(stream, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}
