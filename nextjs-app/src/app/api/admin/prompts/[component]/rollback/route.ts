import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import { rollbackBodySchema, rollbackParamsSchema, type RollbackBody } from '@/lib/validation/safety'
import { rollbackPrompt } from '@/server/services/prompts/rollback'
import type { PromptRollbackResult } from '@/types/safety'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Re-activates an earlier prompt version (the previous one unless a version is named). */
export const POST = route<PromptRollbackResult, RollbackBody, undefined, { component: string }>({
  roles: ['admin'],
  body: rollbackBodySchema,
  handler: async ({ user, body, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    return ok(await rollbackPrompt(user, rollbackParamsSchema.parse(params).component, body.version))
  },
})
