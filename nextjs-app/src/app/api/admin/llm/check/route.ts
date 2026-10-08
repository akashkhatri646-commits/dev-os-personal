import { ok, route } from '@/lib/api/route'
import { checkModelConnection, type ModelCheckResult } from '@/server/services/llm/healthCheck'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Tests the model provider settings with synthetic text: key, model names, structured outputs, embeddings. Admin only. */
export const POST = route<ModelCheckResult>({
  roles: ['admin'],
  rateLimitPerMinute: 6,
  handler: async () => ok(await checkModelConnection()),
})
