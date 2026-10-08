import { ok, route } from '@/lib/api/route'
import { verifyWorkerSecret } from '@/server/worker/auth'
import { runTick, tickOptionsFromEnv, type TickSummary } from '@/server/worker/tick'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Runs one worker pass. Called by the scheduler and by the intake; authenticated by WORKER_SECRET. */
export const POST = route<TickSummary>({
  public: true,
  handler: async ({ req }) => {
    verifyWorkerSecret(req)
    return ok(await runTick(tickOptionsFromEnv()))
  },
})
