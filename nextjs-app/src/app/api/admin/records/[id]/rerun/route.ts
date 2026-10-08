import { AppError } from '@/lib/api/errors'
import { accepted, route } from '@/lib/api/route'
import { recordIdParamsSchema, retryBodySchema, type RetryBody } from '@/lib/validation/ingestion'
import { rerunRecord } from '@/server/services/ingestion/ingestionService'
import type { RecordSummary } from '@/types/records'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Sends a failed or in-review record back to a chosen stage, whatever stopped it. Admin only; audited. */
export const POST = route<RecordSummary, RetryBody, undefined, { id: string }>({
  roles: ['admin'],
  body: retryBodySchema,
  handler: async ({ user, body, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { id } = recordIdParamsSchema.parse(params)
    return accepted(await rerunRecord(user, id, body.from_stage ?? 'extract'))
  },
})
