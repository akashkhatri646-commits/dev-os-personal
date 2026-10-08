import { AppError } from '@/lib/api/errors'
import { paginationQuerySchema } from '@/lib/api/pagination'
import { created, ok, route } from '@/lib/api/route'
import { inviteUserSchema } from '@/lib/validation/auth'
import { inviteUser, listUsers } from '@/server/services/users/userService'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route({
  roles: ['admin'],
  query: paginationQuerySchema,
  handler: async ({ user, query }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { users, nextCursor } = await listUsers(user, query)
    return ok(users, { next_cursor: nextCursor })
  },
})

export const POST = route({
  roles: ['admin'],
  body: inviteUserSchema,
  handler: async ({ user, body }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    return created(await inviteUser(user, body))
  },
})
