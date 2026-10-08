import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { sourceIdParamsSchema } from '@/lib/validation/sources'
import { getThresholdHistory } from '@/server/services/sources/sourceService'
import type { ThresholdVersion } from '@/types/sources'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route<ThresholdVersion[], undefined, undefined, { id: string }>({
  roles: ['integration_engineer', 'admin'],
  handler: async ({ user, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { id } = sourceIdParamsSchema.parse(params)
    return ok(await getThresholdHistory(user, id))
  },
})
