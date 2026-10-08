import 'server-only'
import { timingSafeEqual } from 'node:crypto'
import { AppError } from '@/lib/api/errors'
import { getEnv } from '@/server/config/env'

export const WORKER_SECRET_HEADER = 'x-worker-secret'

/**
 * Authenticates scheduler/internal callers by the shared WORKER_SECRET header (constant-time
 * compare). Fails closed: when no secret is configured nobody is authorised.
 */
export function verifyWorkerSecret(request: Request, expected: string | undefined = getEnv().WORKER_SECRET): void {
  const provided = request.headers.get(WORKER_SECRET_HEADER)
  if (!expected || !provided) throw new AppError('UNAUTHENTICATED', 'Invalid worker credentials.')

  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError('UNAUTHENTICATED', 'Invalid worker credentials.')
  }
}
