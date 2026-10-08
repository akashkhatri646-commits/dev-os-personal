import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { updateUserSchema, userIdParamsSchema, type UpdateUserInput } from '@/lib/validation/auth'
import { updateUser } from '@/server/services/users/userService'
import type { UserSummary } from '@/types/domain'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const PATCH = route<UserSummary, UpdateUserInput, undefined, { id: string }>({
  roles: ['admin'],
  body: updateUserSchema,
  handler: async ({ user, body, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { id } = userIdParamsSchema.parse(params)
    return ok(await updateUser(user, id, body))
  },
})
