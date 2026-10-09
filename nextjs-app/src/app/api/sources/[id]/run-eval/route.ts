import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { runEvaluationBodySchema, sourceIdParamsSchema } from '@/lib/validation/sources'
import { runEvaluation } from '@/server/services/evaluation/evaluationService'
import type { EvaluationView } from '@/types/evaluation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * Judges the source on all reviewed records and stores the result. A pass is what lets auto-commit be enabled.
 * 409 INSUFFICIENT_EVIDENCE when there are not enough reviewed records or fields. Admin only.
 */
export const POST = route<EvaluationView, z.infer<typeof runEvaluationBodySchema>, undefined, { id: string }>({
  roles: ['admin'],
  rateLimitPerMinute: 10,
  body: runEvaluationBodySchema,
  handler: async ({ user, body, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { id } = sourceIdParamsSchema.parse(params)
    return ok(await runEvaluation(user, id, body))
  },
})
