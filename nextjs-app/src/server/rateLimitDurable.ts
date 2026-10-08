import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from '@/server/logger'

/**
 * Sliding-window limit shared by every server instance, kept in the database (`rate_limit_hit`, migration 0008).
 * Use it where a limit matters for security (sign-in, email links, key-authenticated feeds, exports). The
 * in-memory limiter still runs first as a cheap guard; if the database cannot be reached this one logs and
 * lets the request through rather than locking everyone out.
 */
export async function checkDurableRateLimit(key: string, limit: number, windowSeconds = 60): Promise<void> {
  let retryAfter = 0
  try {
    const { data, error } = await getSupabaseAdmin().rpc('rate_limit_hit', { p_key: key, p_limit: limit, p_window_seconds: windowSeconds })
    if (error) throw error
    retryAfter = Number(data ?? 0)
  } catch (error) {
    logger.warn({ err: error }, 'durable rate limit unavailable, relying on the per-instance limit')
    return
  }
  if (retryAfter > 0) {
    throw new AppError('RATE_LIMITED', 'Too many requests. Please retry shortly.', { retryAfterSeconds: retryAfter })
  }
}
