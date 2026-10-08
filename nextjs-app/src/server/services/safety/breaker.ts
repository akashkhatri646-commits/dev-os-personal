import 'server-only'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from '@/server/logger'
import { appendAuditBestEffort } from '@/server/services/audit/auditLog'
import type { JobStage } from '@/server/pipeline/transitions'

/** This many failures in a row, all within the window, open the breaker. */
export const BREAKER_FAILURES = 5
export const BREAKER_WINDOW_MS = 2 * 60_000
/** While open, provider-dependent jobs wait; after this long without a new failure they are tried again. */
export const BREAKER_COOLDOWN_MS = 5 * 60_000
/** Stages that call an outside provider (OCR or the language model). */
export const PROVIDER_STAGES: readonly JobStage[] = ['normalize', 'extract', 'map']

const FAILURE = 'worker.upstream_failure'
/** What counts as the provider working: a stage that depends on it finished. */
const SUCCESSES = ['ocr.completed', 'extraction.completed', 'mapping.completed']

export interface BreakerEvent {
  event: string
  created_at: string
  payload?: Record<string, unknown> | null
}

/** Reading text, HL7 or a PDF text layer uses no outside provider, so finishing it says nothing about the provider's health. */
const LOCAL_ENGINES = ['text', 'hl7-parser', 'pdf-text']

const isProviderOutcome = (entry: BreakerEvent) => !(entry.event === 'ocr.completed' && LOCAL_ENGINES.includes(String(entry.payload?.engine)))

export interface BreakerState {
  open: boolean
  /** When delayed jobs may run again (epoch ms), while open. */
  retryAt: number | null
}

/**
 * Pure rule. `recent` holds the newest outcomes first (failures and successes of provider-dependent
 * work). The breaker is open when the last five are all failures within two minutes of each other
 * and the newest is less than five minutes old. Any success in between closes it, and once five
 * minutes pass without a new failure jobs are tried again; a failure then reopens it at once.
 */
export function evaluateBreaker(recent: readonly BreakerEvent[], now: number): BreakerState {
  const latest = recent.filter(isProviderOutcome).slice(0, BREAKER_FAILURES)
  if (latest.length < BREAKER_FAILURES || latest.some((entry) => entry.event !== FAILURE)) return { open: false, retryAt: null }
  const newest = Date.parse(latest[0]?.created_at ?? '')
  const oldest = Date.parse(latest[latest.length - 1]?.created_at ?? '')
  if (Number.isNaN(newest) || Number.isNaN(oldest) || newest - oldest > BREAKER_WINDOW_MS) return { open: false, retryAt: null }
  const retryAt = newest + BREAKER_COOLDOWN_MS
  return now < retryAt ? { open: true, retryAt } : { open: false, retryAt: null }
}

let cached: { at: number; state: BreakerState } | null = null
const CACHE_MS = 5000

/** Reads the breaker state (cached for a few seconds). If it cannot be read, jobs run: the breaker protects the provider, not data. */
export async function getBreakerState(now = Date.now()): Promise<BreakerState> {
  if (cached && now - cached.at < CACHE_MS) return cached.state
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('audit_log')
      .select('event, created_at, payload')
      .in('event', [FAILURE, ...SUCCESSES])
      .order('id', { ascending: false })
      // A few extra rows: outcomes that use no provider are skipped when counting.
      .limit(BREAKER_FAILURES * 4)
    if (error) throw error
    const state = evaluateBreaker((data ?? []) as BreakerEvent[], now)
    cached = { at: now, state }
    return state
  } catch (error) {
    logger.warn({ err: error }, 'circuit breaker state unavailable')
    return { open: false, retryAt: null }
  }
}

/** Notes one failed provider call so the breaker can count it. */
export async function recordUpstreamFailure(orgId: string, recordId: string, stage: JobStage): Promise<void> {
  cached = null
  await appendAuditBestEffort({ orgId, recordId, actor: { type: 'system' }, event: 'worker.upstream_failure', payload: { stage } })
}

export function resetBreakerCache(): void {
  cached = null
}
