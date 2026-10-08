import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import {
  sourceIdParamsSchema,
  updateSourceSchema,
  type UpdateSourceInput,
} from '@/lib/validation/sources'
import { getSource, updateSource } from '@/server/services/sources/sourceService'
import type { SourceDetail } from '@/types/sources'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route<SourceDetail, undefined, undefined, { id: string }>({
  handler: async ({ user, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { id } = sourceIdParamsSchema.parse(params)
    return ok(await getSource(user, id))
  },
})

export const PATCH = route<SourceDetail, UpdateSourceInput, undefined, { id: string }>({
  roles: ['integration_engineer', 'admin'],
  body: updateSourceSchema,
  handler: async ({ user, body, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { id } = sourceIdParamsSchema.parse(params)
    return ok(await updateSource(user, id, body))
  },
})
