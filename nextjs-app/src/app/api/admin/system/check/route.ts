import { ok, route } from '@/lib/api/route'
import { runSelfCheck, type SelfCheckResult } from '@/server/services/system/selfCheck'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

/** Reports missing configuration, unapplied migrations and a stopped worker. Read-only; admin only. */
export const GET = route<SelfCheckResult>({
  roles: ['admin'],
  handler: async () => ok(await runSelfCheck()),
})
