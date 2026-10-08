import { SYSTEM } from '@/server/services/fhir/constants'

export const ENTERED_IN_ERROR_TAG = { system: 'urn:health-ingest:status', code: 'entered-in-error', display: 'Entered in error' } as const

/** Resource types whose `status` element can carry `entered-in-error`. */
const STATUS_TYPES = ['Encounter', 'MedicationRequest', 'Observation', 'Procedure', 'DiagnosticReport']
/** Types that carry it in `verificationStatus` instead. */
const VERIFICATION_TYPES: Record<string, string> = {
  Condition: SYSTEM.conditionVerification,
  AllergyIntolerance: SYSTEM.allergyVerification,
}

/**
 * Marks a committed resource as entered in error. It is superseded, never deleted: the tag is added
 * and the status (or verification status) says so, so downstream readers stop trusting it while the
 * history stays. Returns a new object; the stored version is archived by the database on update.
 */
export function markEnteredInError(resource: Record<string, unknown>): Record<string, unknown> {
  const type = String(resource.resourceType)
  const meta = (resource.meta ?? {}) as { tag?: { system?: string; code?: string }[] } & Record<string, unknown>
  const tags = (meta.tag ?? []).filter((tag) => tag.code !== ENTERED_IN_ERROR_TAG.code)
  const next: Record<string, unknown> = { ...resource, meta: { ...meta, tag: [...tags, ENTERED_IN_ERROR_TAG] } }
  if (STATUS_TYPES.includes(type)) next.status = 'entered-in-error'
  const verificationSystem = VERIFICATION_TYPES[type]
  if (verificationSystem) next.verificationStatus = { coding: [{ system: verificationSystem, code: 'entered-in-error', display: 'Entered in Error' }] }
  return next
}

export function isEnteredInError(resource: Record<string, unknown>): boolean {
  const meta = (resource.meta ?? {}) as { tag?: { code?: string }[] }
  return (meta.tag ?? []).some((tag) => tag.code === ENTERED_IN_ERROR_TAG.code)
}
