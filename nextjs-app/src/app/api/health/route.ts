import { ok, route } from '@/lib/api/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Liveness probe. Public and dependency-free by design so it works before configuration is complete. */
export const GET = route({
  public: true,
  handler: async () => ok({ status: 'ok' as const, time: new Date().toISOString() }),
})
