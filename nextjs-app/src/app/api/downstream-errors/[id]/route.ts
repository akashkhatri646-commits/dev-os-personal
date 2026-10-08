import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { updateIncidentBodySchema, type UpdateIncidentBody } from '@/lib/validation/safety'
import { updateIncident } from '@/server/services/safety/incidentService'
import type { Incident } from '@/types/safety'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Moves an incident to investigating, or resolves it with a root cause. A source can only resume once its incidents are resolved. */
export const PATCH = route<Incident, UpdateIncidentBody, undefined, { id: string }>({
  roles: ['admin'],
  body: updateIncidentBodySchema,
  handler: async ({ user, body, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    return ok(await updateIncident(user, z.object({ id: z.uuid() }).parse(params).id, body))
  },
})
