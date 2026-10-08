import { AppError } from '@/lib/api/errors'

/** Codes `commit_record` raises for a record that must not be committed. Retrying cannot fix these. */
const REFUSALS = [
  'consent_not_valid',
  'not_routed_auto_commit',
  'ungrounded_field_present',
  'nothing_to_commit',
  'validation_not_passed',
  'patient_required',
  'record_not_found',
  'reviewer_required',
  'no_completed_review',
]

export const ALREADY_COMMITTED = 'already_committed'

/** The stable code in a database error message, or null when it is not one of ours. */
export function commitErrorCode(message: string): string | null {
  if (message.includes(ALREADY_COMMITTED)) return ALREADY_COMMITTED
  const refusal = REFUSALS.find((code) => message.includes(code))
  if (refusal) return refusal
  return /bad_status_\w+/.exec(message)?.[0] ?? null
}

/** Turns a `commit_record` failure into an application error: refusals are final, anything else is retried. */
export function commitErrorToAppError(error: { message: string }): AppError {
  const code = commitErrorCode(error.message)
  if (code && code !== ALREADY_COMMITTED) {
    return new AppError('CONFLICT', 'The record could not be committed.', { reason: code.toUpperCase(), retryable: false, cause: error })
  }
  return new AppError('INTERNAL', 'The commit failed.', { cause: error, retryable: true })
}
