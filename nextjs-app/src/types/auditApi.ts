import type { AuditEvent } from '@/types/audit'

/** One audit entry as returned to the admin console. Payloads never contain PHI (spec 00 §7). */
export interface AuditRow {
  id: number
  created_at: string
  actor_type: 'user' | 'system' | 'api_key'
  actor_id: string | null
  /** Display name for user actors, when known. */
  actor_name: string | null
  event: AuditEvent
  record_id: string | null
  payload: Record<string, unknown>
  /** First 12 hex characters of the entry hash, for visual comparison. */
  hash_short: string
  /** True when the row's own hash and its link to the previous row both verify. */
  hash_ok: boolean
}

export interface AuditVerifyResult {
  ok: boolean
  /** Id of the first entry where the chain breaks, when not ok. */
  first_broken_id: number | null
}
