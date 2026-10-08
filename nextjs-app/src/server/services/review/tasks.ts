import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'

const UNIQUE_VIOLATION = '23505'

export type ReviewKind = 'escalation' | 'holdback_audit' | 'downstream_error_review'

/**
 * Creates a review task for a record. At most one open task exists per (record, kind), so a repeat
 * call is a no-op. `priority` is the static part of the queue ordering (spec 09 §2).
 */
export async function createReviewTask(
  recordId: string,
  kind: ReviewKind = 'escalation',
  priority = 0,
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from('review_tasks')
    .insert({ record_id: recordId, kind, priority })
  if (error && error.code !== UNIQUE_VIOLATION) {
    throw new AppError('INTERNAL', 'Failed to create the review task.', { cause: error, retryable: true })
  }
}
