import { AppError } from '@/lib/api/errors'
import { created, route } from '@/lib/api/route'
import { recordIdParamsSchema } from '@/lib/validation/ingestion'
import { errorReportBodySchema, type ErrorReportBody } from '@/lib/validation/safety'
import { reportDownstreamError } from '@/server/services/safety/incidentService'
import type { Incident } from '@/types/safety'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Reports a confirmed downstream error in committed data. From medium severity the source's
 * auto-commit is paused at once and the reported resource is marked entered in error.
 */
export const POST = route<Incident, ErrorReportBody, undefined, { id: string }>({
  roles: ['reviewer', 'admin'],
  body: errorReportBodySchema,
  handler: async ({ user, body, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    return created(await reportDownstreamError(user, recordIdParamsSchema.parse(params).id, body))
  },
})
