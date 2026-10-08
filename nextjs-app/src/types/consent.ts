export type ConsentResult = 'valid' | 'missing' | 'expired' | 'revoked' | 'out_of_scope' | 'error'
export type ConsentRegime = 'abdm' | 'hipaa'

/** Outcome of one consent check. `detail` never contains patient data. */
export interface ConsentVerdict {
  result: ConsentResult
  /** `consent_artifacts.id` of the artifact that satisfied the check. */
  artifactId?: string
  /** External consent id (ABDM consent artifact id). */
  artifactRef?: string
  matchedScope: string[]
  detail: Record<string, unknown>
}

export interface ConsentQuery {
  orgId: string
  sourceId: string
  patientId: string
  regime: ConsentRegime
  /** Data categories being ingested; every one must be covered. */
  requiredCategories: string[]
  /** Evaluation time. */
  at: Date
}

/** A consent artifact as the matching rules see it. */
export interface ConsentArtifact {
  id: string
  artifact_ref: string
  categories: string[]
  valid_from: string
  valid_to: string
  status: 'granted' | 'revoked' | 'expired'
  created_at: string
}

export type EffectiveConsentStatus = 'valid' | 'expired' | 'revoked' | 'not_yet_valid'

/** A consent artifact as shown in the stub admin console. */
export interface ConsentArtifactView {
  id: string
  artifact_ref: string
  categories: string[]
  valid_from: string
  valid_to: string
  status: 'granted' | 'revoked' | 'expired'
  effective_status: EffectiveConsentStatus
  /** Masked identifier, e.g. `ABHA ••••1234`. */
  patient_label: string
  created_at: string
}

export const CONSENT_BLOCK_RESULTS: readonly ConsentResult[] = ['missing', 'expired', 'revoked', 'out_of_scope']
