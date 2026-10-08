import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { recordIdParamsSchema } from '@/lib/validation/ingestion'
import { getRecordTrace } from '@/server/services/records/traceService'
import type { RecordTrace } from '@/types/trace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Fields with citations and scores, FHIR resources, the routing decision and provenance for one record. */
export const GET = route<RecordTrace, undefined, undefined, { id: string }>({
  roles: ['integration_engineer', 'reviewer', 'admin'],
  handler: async ({ user, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    return ok(await getRecordTrace(user, recordIdParamsSchema.parse(params).id))
  },
})
