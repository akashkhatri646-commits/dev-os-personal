import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { reasonBodySchema, sourceIdParamsSchema } from '@/lib/validation/sources'
import { pauseSource } from '@/server/services/sources/sourceService'
import type { SourceDetail } from '@/types/sources'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Stops auto-commit for the source; every new record is routed to manual review. */
export const POST = route<SourceDetail, z.infer<typeof reasonBodySchema>, undefined, { id: string }>({
  roles: ['admin'],
  body: reasonBodySchema,
  handler: async ({ user, body, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { id } = sourceIdParamsSchema.parse(params)
    return ok(await pauseSource(user, id, body.reason))
  },
})
