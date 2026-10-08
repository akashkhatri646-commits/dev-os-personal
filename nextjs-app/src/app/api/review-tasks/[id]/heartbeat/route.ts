import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { taskIdParamsSchema } from '@/lib/validation/review'
import { heartbeatTask } from '@/server/services/review/reviewService'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Keeps the reviewer's hold on a task alive while the workspace is open. */
export const POST = route<{ lock_expires_at: string }, undefined, undefined, { id: string }>({
  roles: ['reviewer', 'admin'],
  handler: async ({ user, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    return ok(await heartbeatTask(user, taskIdParamsSchema.parse(params).id))
  },
})
