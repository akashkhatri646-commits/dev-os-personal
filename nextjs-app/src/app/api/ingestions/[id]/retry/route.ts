import { AppError } from '@/lib/api/errors'
import { accepted, route } from '@/lib/api/route'
import { recordIdParamsSchema, retryBodySchema, type RetryBody } from '@/lib/validation/ingestion'
import { retryRecord } from '@/server/services/ingestion/ingestionService'
import type { RecordSummary } from '@/types/records'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Re-runs a failed or escalated record from the failed stage. At most 3 manual retries per record. */
export const POST = route<RecordSummary, RetryBody, undefined, { id: string }>({
  roles: ['integration_engineer', 'admin'],
  body: retryBodySchema,
  handler: async ({ user, body, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { id } = recordIdParamsSchema.parse(params)
    return accepted(await retryRecord(user, id, body))
  },
})
