import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { containsPersonalData } from '@/lib/validation/phi'
import { logger } from '@/server/logger'
import type { AuditActor, AuditEvent, AuditPayload } from '@/types/audit'

export interface AuditEntry {
  orgId: string
  recordId?: string | null
  actor: AuditActor
  event: AuditEvent
  payload?: AuditPayload
}

/**
 * Guards the "no PHI in audit payloads" rule (spec 00 §7): payloads carry ids, enums and numbers only.
 * Throws on anything that looks like an email address or a 10+ digit identifier (ABHA, phone numbers).
 */
export function assertNoPhi(payload: AuditPayload): void {
  if (containsPersonalData(JSON.stringify(payload))) {
    throw new AppError('INTERNAL', 'Audit payload appears to contain personal data.', {
      retryable: false,
    })
  }
}

/**
 * Appends an immutable audit entry. The database trigger computes the hash chain; there is no
 * update or delete path. Use for state-changing steps where a missing audit row must abort the step.
 */
export async function appendAudit(entry: AuditEntry): Promise<void> {
  const payload = entry.payload ?? {}
  assertNoPhi(payload)

  const { error } = await getSupabaseAdmin().from('audit_log').insert({
    org_id: entry.orgId,
    record_id: entry.recordId ?? null,
    actor_type: entry.actor.type,
    actor_id: entry.actor.id ?? null,
    event: entry.event,
    payload,
  })
  if (error) {
    throw new AppError('INTERNAL', 'Failed to write audit entry.', {
      retryable: true,
      cause: error,
    })
  }
}

/** For read-style or authentication events where failing to log must not break the user's action. */
export async function appendAuditBestEffort(entry: AuditEntry): Promise<void> {
  try {
    await appendAudit(entry)
  } catch (error) {
    logger.warn({ event: entry.event, err: error }, 'audit write failed (best effort)')
  }
}
