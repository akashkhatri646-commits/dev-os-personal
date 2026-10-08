import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { reuploadBodySchema, taskIdParamsSchema, type ReuploadBody } from '@/lib/validation/review'
import { requestReupload } from '@/server/services/review/reviewService'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Closes the record and asks the provider for a new copy (scan, file or language problems only). */
export const POST = route<{ requested: true }, ReuploadBody, undefined, { id: string }>({
  roles: ['reviewer', 'admin'],
  body: reuploadBodySchema,
  handler: async ({ user, body, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    await requestReupload(user, taskIdParamsSchema.parse(params).id, body)
    return ok({ requested: true })
  },
})
