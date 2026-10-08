import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { sourceIdParamsSchema } from '@/lib/validation/sources'
import { rotateKey } from '@/server/services/sources/sourceService'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Issues a new API key and revokes the old one immediately. The new key is shown once. */
export const POST = route<{ api_key: string }, undefined, undefined, { id: string }>({
  roles: ['admin'],
  handler: async ({ user, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { id } = sourceIdParamsSchema.parse(params)
    return ok(await rotateKey(user, id))
  },
})
