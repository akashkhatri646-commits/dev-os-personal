import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import {
  setThresholdSchema,
  sourceIdParamsSchema,
  type SetThresholdInput,
} from '@/lib/validation/sources'
import { setThreshold } from '@/server/services/sources/sourceService'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Sets a new threshold version for one resource type (`*` = default). Reason is mandatory and audited. */
export const PUT = route<
  { version: number; previous: number | null },
  SetThresholdInput,
  undefined,
  { id: string }
>({
  roles: ['integration_engineer', 'admin'],
  body: setThresholdSchema,
  handler: async ({ user, body, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { id } = sourceIdParamsSchema.parse(params)
    return ok(await setThreshold(user, id, body))
  },
})
