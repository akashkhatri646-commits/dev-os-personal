import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { auditSearchSchema, type AuditSearchInput } from '@/lib/validation/audit'
import { searchAudit } from '@/server/services/audit/auditQuery'
import type { AuditRow } from '@/types/auditApi'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Audit search. POST on purpose: filters may include a patient identifier, which must never
 * appear in a URL. Admin only.
 */
export const POST = route<AuditRow[], AuditSearchInput>({
  roles: ['admin'],
  body: auditSearchSchema,
  handler: async ({ user, body }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { rows, nextCursor } = await searchAudit(user, body)
    return ok(rows, { next_cursor: nextCursor })
  },
})
