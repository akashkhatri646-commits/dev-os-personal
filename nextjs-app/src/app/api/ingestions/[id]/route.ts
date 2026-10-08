import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { recordIdParamsSchema } from '@/lib/validation/ingestion'
import { getRecordDetail } from '@/server/services/ingestion/ingestionService'
import type { RecordDetail } from '@/types/records'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route<RecordDetail, undefined, undefined, { id: string }>({
  roles: ['integration_engineer', 'reviewer', 'admin'],
  handler: async ({ user, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { id } = recordIdParamsSchema.parse(params)
    return ok(await getRecordDetail(user, id))
  },
})
