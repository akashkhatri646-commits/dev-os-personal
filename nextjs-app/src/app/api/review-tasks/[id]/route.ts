import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { taskIdParamsSchema } from '@/lib/validation/review'
import { getWorkspace } from '@/server/services/review/reviewService'
import type { ReviewWorkspace } from '@/types/review'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Everything the reviewer needs for one task: source text, draft fields, scores and the routing trace. */
export const GET = route<ReviewWorkspace, undefined, undefined, { id: string }>({
  roles: ['reviewer', 'admin'],
  handler: async ({ user, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    return ok(await getWorkspace(user, taskIdParamsSchema.parse(params).id))
  },
})
