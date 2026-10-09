import { ok, route } from '@/lib/api/route'
import { verifyWorkerSecret } from '@/server/worker/auth'
import { triggerWorkerTick } from '@/server/worker/trigger'
import { runTick, tickOptionsFromEnv, type TickSummary } from '@/server/worker/tick'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Runs one worker pass. Called by the scheduler, by the intake and by a pass that ran out of time; authenticated by WORKER_SECRET. */
export const POST = route<TickSummary>({
  public: true,
  handler: async ({ req }) => {
    verifyWorkerSecret(req)
    const summary = await runTick(tickOptionsFromEnv())
    // Out of time with work still arriving (a record's next stage was just queued): carry on right away instead of
    // waiting for the next scheduled call.
    if (summary.more) await triggerWorkerTick()
    return ok(summary)
  },
})
