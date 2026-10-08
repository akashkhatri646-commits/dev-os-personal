import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { created, route } from '@/lib/api/route'
import { flagPoorSchema, sourceIdParamsSchema } from '@/lib/validation/sources'
import { flagSourcePoor } from '@/server/services/sources/sourceService'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Reviewer/admin flag that a source is consistently poor. Shows a warning; does not pause by itself. */
export const POST = route<{ flagged: true }, z.infer<typeof flagPoorSchema>, undefined, { id: string }>({
  roles: ['reviewer', 'admin'],
  body: flagPoorSchema,
  handler: async ({ user, body, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { id } = sourceIdParamsSchema.parse(params)
    await flagSourcePoor(user, id, body.note)
    return created({ flagged: true as const })
  },
})
