import 'server-only'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from '@/server/logger'

/**
 * Reopens review tasks whose lock ran out and returns their records to the queue. Called on every
 * worker tick; a failure here is logged and never stops the tick.
 */
export async function sweepExpiredReviewLocks(): Promise<number> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc('release_expired_review_locks')
    if (error) throw error
    const released = typeof data === 'number' ? data : 0
    if (released > 0) logger.info({ released }, 'review locks expired')
    return released
  } catch (error) {
    logger.warn({ err: error }, 'review lock sweep failed')
    return 0
  }
}
