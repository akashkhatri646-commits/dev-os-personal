import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getEnv } from '@/server/config/env'
import { logger } from '@/server/logger'
import { StubConsentLedger } from '@/server/services/consent/StubConsentLedger'
import type { ConsentQuery, ConsentVerdict } from '@/types/consent'

/** A consent ledger: the stub reads our own table, the ABDM client calls the Consent Manager. */
export interface ConsentService {
  verify(query: ConsentQuery): Promise<ConsentVerdict>
}

/** Consent lookups must answer fast; a slow ledger is treated as an error, never as consent. */
export const CONSENT_TIMEOUT_MS = 5000

function errorVerdict(reason: string): ConsentVerdict {
  return { result: 'error', matchedScope: [], detail: { reason } }
}

/**
 * Runs a verification with the fail-closed contract (spec 05 §3, rule 7): an exception, a timeout
 * or a malformed answer becomes an `error` verdict, which blocks processing. It never throws.
 */
export async function verifyConsent(
  service: ConsentService,
  query: ConsentQuery,
  timeoutMs = CONSENT_TIMEOUT_MS,
): Promise<ConsentVerdict> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<ConsentVerdict>((resolve) => {
      timer = setTimeout(() => resolve(errorVerdict('timeout')), timeoutMs)
    })
    return await Promise.race([service.verify(query), timeout])
  } catch (error) {
    logger.warn({ err: error }, 'consent verification failed')
    return errorVerdict('exception')
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * The ledger selected by CONSENT_MODE. The ABDM Consent Manager client ships with MVP 1; until
 * then selecting it fails closed (every record is blocked by a consent-service error), it never
 * falls back to the stub.
 */
export function getConsentService(mode: 'stub' | 'abdm' = getEnv().CONSENT_MODE): ConsentService {
  if (mode === 'stub') return new StubConsentLedger()
  throw new AppError('INTERNAL', 'The ABDM consent client is not available in this release.', {
    retryable: false,
  })
}

/**
 * Guard for every stage that reads document content (OCR, extraction, ...): consent must have been
 * verified as `valid` for the record. Throws a non-retryable error otherwise, so no content is ever
 * processed ahead of, or without, a consent check.
 */
export async function assertConsentValid(recordId: string): Promise<void> {
  const { data, error } = await getSupabaseAdmin()
    .from('consent_checks')
    .select('result')
    .eq('record_id', recordId)
    .maybeSingle()
  if (error) throw new AppError('INTERNAL', 'Failed to read the consent check.', { cause: error, retryable: true })
  if (data?.result !== 'valid') {
    throw new AppError('FORBIDDEN', 'Processing requires a valid consent check.', {
      reason: 'CONSENT_REQUIRED',
      retryable: false,
    })
  }
}
