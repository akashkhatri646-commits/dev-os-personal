import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { listReviewTasksQuerySchema, type ListReviewTasksQuery } from '@/lib/validation/review'
import { listTasks } from '@/server/services/review/reviewService'
import type { ReviewTaskSummary } from '@/types/review'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The review queue: highest priority (plus age) first. */
export const GET = route<ReviewTaskSummary[], undefined, ListReviewTasksQuery>({
  roles: ['reviewer', 'admin'],
  query: listReviewTasksQuerySchema,
  handler: async ({ user, query }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { tasks, nextCursor } = await listTasks(user, query)
    return ok(tasks, { next_cursor: nextCursor })
  },
})
