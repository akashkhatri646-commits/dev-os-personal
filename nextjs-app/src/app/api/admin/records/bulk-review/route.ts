import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { bulkReviewBodySchema, type BulkReviewBody } from '@/lib/validation/safety'
import { bulkCreateReviews } from '@/server/services/safety/incidentService'
import type { BulkReviewResult } from '@/types/safety'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Queues a downstream-error review for each listed record, one open task per record. */
export const POST = route<BulkReviewResult, BulkReviewBody>({
  roles: ['admin'],
  body: bulkReviewBodySchema,
  handler: async ({ user, body }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    return ok(await bulkCreateReviews(user, body))
  },
})
