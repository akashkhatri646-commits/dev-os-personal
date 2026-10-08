// Shared domain contracts (docs/specs/00-overview-and-conventions.md §5). Safe to import from client and server.

export const ROLES = ['integration_engineer', 'reviewer', 'admin', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export const RECORD_STATUSES = [
  'received',
  'consent_check',
  'blocked_consent',
  'normalizing',
  'extracting',
  'mapping',
  'validating',
  'scoring',
  'routing',
  'needs_review',
  'in_review',
  'auto_committed',
  'committed',
  'rejected',
  'failed',
] as const
export type RecordStatus = (typeof RECORD_STATUSES)[number]

export const RESOURCE_TYPES = [
  'Condition',
  'MedicationRequest',
  'AllergyIntolerance',
  'Observation',
  'DiagnosticReport',
  'Encounter',
  'Procedure',
] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]

export type CodeSystem = 'snomed' | 'loinc' | 'icd10'

export const FHIR_SYSTEM_URI: Record<CodeSystem, string> = {
  snomed: 'http://snomed.info/sct',
  loinc: 'http://loinc.org',
  icd10: 'http://hl7.org/fhir/sid/icd-10',
}

export type DocType = 'discharge_summary' | 'lab_report' | 'other'
export type InputKind = 'pdf' | 'image' | 'hl7v2' | 'text'

export interface SourceSpan {
  page: number
  block_ids: string[]
  quote: string
  char_start: number
  char_end: number
  bbox?: [number, number, number, number]
}

export interface ExtractedField {
  field_key: string
  resource_type: ResourceType
  value: unknown | null
  found: boolean
  source_span: SourceSpan | null
  basis: 'stated' | 'inferred' | null
  confidence: number
}

export interface Coding {
  field_key: string
  system: CodeSystem
  code: string
  display: string
  match_confidence: number
  candidates: { code: string; display: string; score: number }[]
}

export type EscalationReason =
  | 'below_threshold'
  | 'schema_invalid'
  | 'ungrounded'
  | 'low_ocr'
  | 'source_not_enabled'
  | 'holdback'
  | 'llm_error'
  | 'stage_error'
  | 'ambiguous_label'
  | 'uncoded'
  | 'low_ocr_quality'

export interface RoutingDecision {
  record_id: string
  aggregate_score: number
  decision: 'auto_commit' | 'escalate'
  escalation_reasons: EscalationReason[]
  thresholds_applied: Record<
    string,
    { threshold: number; version: number; score: number; pass: boolean }
  >
  validation_result: 'pass' | 'fail' | 'pending'
  reasoning_trace: string
  rule_version: string
}

/** Authenticated principal resolved from the Supabase session and the `profiles` table. */
export interface AuthUser {
  userId: string
  email: string | null
  orgId: string
  orgName: string | null
  fullName: string | null
  role: Role
  /** Present only when the caller authenticated with an Authorization: Bearer token. */
  accessToken?: string
}

/** A user as listed in the admin console. */
export interface UserSummary {
  id: string
  email: string
  full_name: string | null
  role: Role
  active: boolean
  last_sign_in_at: string | null
  created_at: string
}

/** API response envelope (spec 00 §6). */
export interface ApiSuccess<T> {
  data: T
  meta?: { next_cursor?: string | null; [key: string]: unknown }
}

export interface ApiErrorBody {
  error: {
    code: ErrorCode
    message: string
    details?: unknown
    request_id: string
  }
}

export const ERROR_HTTP_STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  GONE: 410,
  INVALID_TRANSITION: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  INTERNAL: 500,
} as const

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS
