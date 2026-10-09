import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { evaluationQuerySchema, sourceIdParamsSchema } from '@/lib/validation/sources'
import { getEvaluation } from '@/server/services/evaluation/evaluationService'
import type { EvaluationView } from '@/types/evaluation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

/** How accurate the source's output has been, from its reviewers' decisions. Read-only. */
export const GET = route<EvaluationView, undefined, z.infer<typeof evaluationQuerySchema>, { id: string }>({
  roles: ['integration_engineer', 'admin'],
  query: evaluationQuerySchema,
  handler: async ({ user, query, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { id } = sourceIdParamsSchema.parse(params)
    return ok(await getEvaluation(user, id, query.days ?? null))
  },
})
