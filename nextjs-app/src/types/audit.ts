/** Audit event catalog (docs/specs/00-overview-and-conventions.md §7). Payloads never contain PHI. */
export const AUDIT_EVENTS = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'user.created',
  'user.role_changed',
  'source.created',
  'source.updated',
  'source.key_rotated',
  'source.key_rejected',
  'source.paused',
  'source.resumed',
  'source.auto_commit_enabled',
  'threshold.changed',
  'ingest.received',
  'ingest.duplicate',
  'record.status_changed',
  'consent.checked',
  'consent.blocked',
  'consent.artifact_created',
  'consent.artifact_updated',
  'ocr.completed',
  'ocr.rejected_low_quality',
  'extraction.completed',
  'extraction.injection_suspected',
  'mapping.completed',
  'validation.completed',
  'scoring.completed',
  'routing.decided',
  'review.claimed',
  'review.released',
  'review.submitted',
  'review.reupload_requested',
  'record.phi_purged',
  'record.committed',
  'record.rejected',
  'document.accessed',
  'audit.exported',
  'audit.reconstructed',
  'error.updated',
  'review.bulk_created',
  'worker.upstream_failure',
  'source.paused_all',
  'error.reported',
  'alert.raised',
  'calibration.proposed',
  'calibration.applied',
  'prompt.activated',
  'prompt.rolled_back',
  'worker.job_failed',
  'record.rerun_requested',
  'source.eval_run',
  'source.eval_reset',
] as const

export type AuditEvent = (typeof AUDIT_EVENTS)[number]

export type AuditActor =
  | { type: 'user'; id: string }
  | { type: 'api_key'; id: string }
  | { type: 'system'; id?: undefined }

export type AuditPayloadValue = string | number | boolean | null | AuditPayloadValue[] | { [key: string]: AuditPayloadValue }
export type AuditPayload = Record<string, AuditPayloadValue>
