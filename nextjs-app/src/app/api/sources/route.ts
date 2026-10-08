import { AppError } from '@/lib/api/errors'
import { paginationQuerySchema } from '@/lib/api/pagination'
import { created, ok, route } from '@/lib/api/route'
import { createSourceSchema } from '@/lib/validation/sources'
import { createSource, listSources } from '@/server/services/sources/sourceService'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route({
  query: paginationQuerySchema,
  handler: async ({ user, query }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { sources, nextCursor } = await listSources(user, query)
    return ok(sources, { next_cursor: nextCursor })
  },
})

export const POST = route({
  roles: ['integration_engineer', 'admin'],
  body: createSourceSchema,
  handler: async ({ user, body }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    return created(await createSource(user, body))
  },
})
