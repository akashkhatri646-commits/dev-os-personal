import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { noteBodySchema, sourceIdParamsSchema } from '@/lib/validation/sources'
import { resumeSource } from '@/server/services/sources/sourceService'
import type { SourceDetail } from '@/types/sources'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = route<SourceDetail, z.infer<typeof noteBodySchema>, undefined, { id: string }>({
  roles: ['admin'],
  body: noteBodySchema,
  handler: async ({ user, body, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { id } = sourceIdParamsSchema.parse(params)
    return ok(await resumeSource(user, id, body.note))
  },
})
