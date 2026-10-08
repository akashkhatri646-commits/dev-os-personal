import 'server-only'
import { AppError } from '@/lib/api/errors'

interface Window {
  count: number
  resetAt: number
}

const WINDOW_MS = 60_000
const MAX_TRACKED_KEYS = 10_000
const windows = new Map<string, Window>()

/**
 * Fixed-window limiter keyed by user id, source-key id or IP. State is per server instance, so on
 * serverless hosting the effective limit is a best-effort ceiling per instance; the worker and
 * database remain the authoritative guards against abuse.
 */
export function checkRateLimit(key: string, limitPerMinute: number, now = Date.now()): void {
  if (windows.size > MAX_TRACKED_KEYS) {
    for (const [trackedKey, window] of windows) {
      if (window.resetAt <= now) windows.delete(trackedKey)
    }
  }

  const current = windows.get(key)
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return
  }

  current.count += 1
  if (current.count > limitPerMinute) {
    const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000))
    throw new AppError('RATE_LIMITED', 'Too many requests. Please retry shortly.', {
      retryAfterSeconds,
    })
  }
}
