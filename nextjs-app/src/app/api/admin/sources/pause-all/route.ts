import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { pauseAllBodySchema, type PauseAllBody } from '@/lib/validation/safety'
import { pauseAllSources } from '@/server/services/safety/incidentService'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Emergency stop: pauses auto-commit on every source that has it on. */
export const POST = route<{ paused: number }, PauseAllBody>({
  roles: ['admin'],
  body: pauseAllBodySchema,
  handler: async ({ user, body }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    return ok(await pauseAllSources(user, body))
  },
})
