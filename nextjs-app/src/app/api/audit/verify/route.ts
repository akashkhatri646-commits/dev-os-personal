import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { verifyChain } from '@/server/services/audit/auditQuery'
import type { AuditVerifyResult } from '@/types/auditApi'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Verifies the whole hash chain for the organisation. Admin only; limited because it scans every entry. */
export const GET = route<AuditVerifyResult>({
  roles: ['admin'],
  rateLimitPerMinute: 6,
  handler: async ({ user }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    return ok(await verifyChain(user))
  },
})
