import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { submitReviewBodySchema, taskIdParamsSchema, type SubmitReviewBody } from '@/lib/validation/review'
import { submitReview } from '@/server/services/review/reviewService'
import type { ReviewSubmitResult } from '@/types/review'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Approves (and commits) or rejects the record from the reviewer's field decisions. */
export const POST = route<ReviewSubmitResult, SubmitReviewBody, undefined, { id: string }>({
  roles: ['reviewer', 'admin'],
  body: submitReviewBodySchema,
  handler: async ({ user, body, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    return ok(await submitReview(user, taskIdParamsSchema.parse(params).id, body))
  },
})
