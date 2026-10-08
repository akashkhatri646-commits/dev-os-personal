import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { sendAlert } from '@/server/services/alerts/alerts'
import { appendAuditBestEffort } from '@/server/services/audit/auditLog'
import { verifyWorkerSecret } from '@/server/worker/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface VerifySummary {
  organisations: number
  broken: { org_id: string; first_broken_id: number }[]
}

/**
 * Daily integrity job: verifies every organisation's audit hash chain and alerts on a break.
 * Authenticated by WORKER_SECRET (called by the scheduler).
 */
export const POST = route<VerifySummary>({
  public: true,
  handler: async ({ req }) => {
    verifyWorkerSecret(req)
    const admin = getSupabaseAdmin()

    const { data: orgs, error } = await admin.from('organizations').select('id')
    if (error) throw new AppError('INTERNAL', 'Failed to list organisations.', { cause: error })

    const broken: VerifySummary['broken'] = []
    for (const org of orgs ?? []) {
      const orgId = org.id as string
      const { data, error: rpcError } = await admin.rpc('verify_audit_chain', { p_org: orgId })
      if (rpcError) throw new AppError('INTERNAL', 'Failed to verify the audit chain.', { cause: rpcError })
      const firstBroken = z.number().nullable().parse(data ?? null)
      if (firstBroken === null) continue

      broken.push({ org_id: orgId, first_broken_id: firstBroken })
      await appendAuditBestEffort({
        orgId,
        actor: { type: 'system' },
        event: 'alert.raised',
        payload: { kind: 'audit_chain_broken', first_broken_id: firstBroken },
      })
      await sendAlert({
        kind: 'audit_chain_broken',
        message: `Audit chain integrity check failed for organisation ${orgId} at entry #${firstBroken}.`,
      })
    }
    return ok({ organisations: (orgs ?? []).length, broken })
  },
})
