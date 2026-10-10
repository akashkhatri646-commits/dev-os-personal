import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { recordIdParamsSchema } from '@/lib/validation/ingestion'
import { kickRecord } from '@/server/services/ingestion/ingestionService'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Asks the worker to process a record that has been waiting. Safe to call repeatedly: it only acts when a job for the
 * record is due and idle, and a record's page calls it when the record has not moved for a while.
 */
export const POST = route<{ kicked: boolean }, undefined, undefined, { id: string }>({
  roles: ['integration_engineer', 'reviewer', 'admin'],
  rateLimitPerMinute: 12,
  handler: async ({ user, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { id } = recordIdParamsSchema.parse(params)
    return ok(await kickRecord(user, id))
  },
})
