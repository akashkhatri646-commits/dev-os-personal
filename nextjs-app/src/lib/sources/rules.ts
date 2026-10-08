import { RESOURCE_TYPES, type ResourceType } from '@/types/domain'

/** Threshold rules shared by the API and the UI (docs/specs/02-sources-thresholds.md). */
export const THRESHOLD_MIN = 0.5
export const THRESHOLD_MAX = 0.999
export const HIGH_RISK_THRESHOLD_FLOOR = 0.95
export const MIN_HOLDBACK_PCT_WHEN_ENABLED = 5

/** Resource types that carry patient-safety risk: stricter floor and default. */
export const HIGH_RISK_RESOURCE_TYPES: readonly ResourceType[] = [
  'MedicationRequest',
  'AllergyIntolerance',
  'Observation',
]

/** Resource types with a floor below which a threshold cannot be set. */
export const FLOORED_RESOURCE_TYPES: readonly ResourceType[] = ['MedicationRequest', 'AllergyIntolerance']

export const THRESHOLD_RESOURCE_KEYS = ['*', ...RESOURCE_TYPES] as const
export type ThresholdResourceKey = (typeof THRESHOLD_RESOURCE_KEYS)[number]

export const RESOURCE_KEY_LABEL: Record<ThresholdResourceKey, string> = {
  '*': 'Default (all other types)',
  Condition: 'Condition',
  MedicationRequest: 'MedicationRequest',
  AllergyIntolerance: 'AllergyIntolerance',
  Observation: 'Observation (labs)',
  DiagnosticReport: 'DiagnosticReport',
  Encounter: 'Encounter',
  Procedure: 'Procedure',
}

export interface ActiveThreshold {
  resource_type: string
  threshold: number
  version: number
}

/**
 * Effective threshold for a resource type: the exact-type active row, else the `*` row, else 1.0.
 * The 1.0 fallback fails closed (nothing auto-commits without a configured threshold).
 */
export function resolveThreshold(
  rows: readonly ActiveThreshold[],
  resourceType: string,
): { threshold: number; version: number | null } {
  const exact = rows.find((row) => row.resource_type === resourceType)
  if (exact) return { threshold: exact.threshold, version: exact.version }
  const fallback = rows.find((row) => row.resource_type === '*')
  if (fallback) return { threshold: fallback.threshold, version: fallback.version }
  return { threshold: 1, version: null }
}

/** Minimum allowed threshold for a resource key (higher for medication/allergy). */
export function thresholdFloor(resourceKey: string): number {
  return (FLOORED_RESOURCE_TYPES as readonly string[]).includes(resourceKey)
    ? HIGH_RISK_THRESHOLD_FLOOR
    : THRESHOLD_MIN
}
