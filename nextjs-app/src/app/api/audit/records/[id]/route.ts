import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { recordIdParamsSchema } from '@/lib/validation/ingestion'
import { reconstructRecord } from '@/server/services/audit/reconstruct'
import type { Reconstruction } from '@/types/trace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Why a record was committed or escalated: the audit chain joined with each stage's stored result. Admin only. */
export const GET = route<Reconstruction, undefined, undefined, { id: string }>({
  roles: ['admin'],
  handler: async ({ user, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    return ok(await reconstructRecord(user, recordIdParamsSchema.parse(params).id))
  },
})
