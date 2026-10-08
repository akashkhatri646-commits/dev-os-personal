import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getAuthUser, requireRole } from '@/lib/auth/withAuth'
import { getEnv } from '@/server/config/env'
import { allowedHosts, assertSameOrigin } from '@/lib/api/requestOrigin'
import { checkRateLimit } from '@/server/rateLimit'
import { checkDurableRateLimit } from '@/server/rateLimitDurable'
import type { IngestionPrincipal } from '@/server/services/ingestion/ingestionService'
import { authenticateSourceKey } from '@/server/services/sources/sourceKeys'

export const SOURCE_KEY_HEADER = 'x-source-key'

/**
 * Resolves who is submitting. A feed integration presents `X-Source-Key`; everyone else must be a
 * signed-in integration engineer or admin. Each principal has its own per-minute limit.
 */
export async function resolveIngestionPrincipal(request: Request): Promise<IngestionPrincipal> {
  const env = getEnv()
  const keyHeader = request.headers.get(SOURCE_KEY_HEADER)

  if (keyHeader) {
    const source = await authenticateSourceKey(keyHeader)
    checkRateLimit(`source-key:${source.keyId}`, env.RATE_LIMIT_SOURCE_KEY_PER_MIN)
    await checkDurableRateLimit(`source-key:${source.keyId}`, env.RATE_LIMIT_SOURCE_KEY_PER_MIN)
    return { kind: 'source_key', orgId: source.orgId, sourceId: source.sourceId, keyId: source.keyId }
  }

  assertSameOrigin(request, allowedHosts(request, env.APP_BASE_URL))
  const user = await getAuthUser(request)
  if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
  requireRole(user, ['integration_engineer', 'admin'])
  checkRateLimit(`user:${user.userId}`, env.RATE_LIMIT_USER_PER_MIN)
  return { kind: 'user', user }
}
