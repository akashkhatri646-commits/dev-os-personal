import { ok, route } from '@/lib/api/route'
import { getAuthUser } from '@/lib/auth/withAuth'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { appendAuditBestEffort } from '@/server/services/audit/auditLog'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Ends the session on the server so the cookies are cleared with the right attributes, and records it.
 * Public on purpose: a caller whose session already expired must still be able to clear the cookies.
 */
export const POST = route({
  public: true,
  rateLimitPerMinute: 30,
  handler: async ({ req }) => {
    const user = await getAuthUser(req).catch(() => null)
    await createSupabaseServerClient().auth.signOut()
    if (user) {
      await appendAuditBestEffort({ orgId: user.orgId, actor: { type: 'user', id: user.userId }, event: 'auth.logout', payload: {} })
    }
    return ok({ signed_out: true })
  },
})
