import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { taskIdParamsSchema } from '@/lib/validation/review'
import { releaseTask } from '@/server/services/review/reviewService'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Hands a task back to the queue. The reviewer holding it, or an admin, may do this. */
export const POST = route<{ released: true }, undefined, undefined, { id: string }>({
  roles: ['reviewer', 'admin'],
  handler: async ({ user, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    await releaseTask(user, taskIdParamsSchema.parse(params).id)
    return ok({ released: true })
  },
})
