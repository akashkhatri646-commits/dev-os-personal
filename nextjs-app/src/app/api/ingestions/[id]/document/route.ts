import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { recordIdParamsSchema } from '@/lib/validation/ingestion'
import { getDocumentAccess } from '@/server/services/ingestion/ingestionService'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Signed URL (5 minutes by default) for the stored original. Audited; refused for consent-blocked records. */
export const GET = route<{ url: string; expires_in: number; mime_type: string; pages: number | null }, undefined, undefined, { id: string }>({
  roles: ['integration_engineer', 'reviewer', 'admin'],
  handler: async ({ user, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { id } = recordIdParamsSchema.parse(params)
    return ok(await getDocumentAccess(user, id))
  },
})
