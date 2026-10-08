import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { listIncidentsQuerySchema, type ListIncidentsQuery } from '@/lib/validation/safety'
import { listIncidents } from '@/server/services/safety/incidentService'
import type { Incident } from '@/types/safety'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route<Incident[], undefined, ListIncidentsQuery>({
  roles: ['admin'],
  query: listIncidentsQuerySchema,
  handler: async ({ user, query }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { incidents, nextCursor } = await listIncidents(user, query)
    return ok(incidents, { next_cursor: nextCursor })
  },
})
