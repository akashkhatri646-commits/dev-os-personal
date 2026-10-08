import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Current user's profile and role. */
export const GET = route({
  handler: async ({ user }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    return ok({
      id: user.userId,
      email: user.email,
      full_name: user.fullName,
      role: user.role,
      org_id: user.orgId,
      org_name: user.orgName,
    })
  },
})
