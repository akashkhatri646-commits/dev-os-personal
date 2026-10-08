import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { getDashboard } from '@/server/services/metrics/dashboard'
import type { DashboardData } from '@/types/metrics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const querySchema = z.object({ days: z.coerce.number().int().refine((value) => [7, 30, 90].includes(value), 'days must be 7, 30 or 90').default(30) })

/** Per-source operational numbers (counts, rates with sample sizes, timings, cost). Aggregates only, so every role may read them. */
export const GET = route<DashboardData, undefined, z.infer<typeof querySchema>>({
  query: querySchema,
  handler: async ({ user, query }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    return ok(await getDashboard(user, query.days))
  },
})
