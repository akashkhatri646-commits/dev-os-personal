import type { AttributeKind } from '@/server/services/extraction/fieldCatalog'
import type { CodeSystem, DocType, RecordStatus } from '@/types/domain'

export type ReviewKind = 'escalation' | 'holdback_audit' | 'downstream_error_review'
export type ReviewTaskStatus = 'open' | 'claimed' | 'completed' | 'released'
export type ReviewAction = 'accept' | 'correct' | 'reject'

export interface ReviewTaskSummary {
  id: string
  record_id: string
  kind: ReviewKind
  status: ReviewTaskStatus
  priority: number
  source_name: string
  doc_type: DocType
  reasons: string[]
  /** Lowest resource score, or null when the record was never scored. */
  min_field_score: number | null
  resource_types: string[]
  age_minutes: number
  claimed_by_name: string | null
  claimed_by_me: boolean
  lock_expires_at: string | null
  created_at: string
}

export interface WorkspaceCoding {
  system: CodeSystem
  code: string
  display: string
  match_confidence: number
  candidates: { code: string; display: string; score: number }[]
}

export interface WorkspaceSpan {
  page: number
  quote: string
  block_ids: string[]
  char_start: number
  char_end: number
  manual?: boolean
}

export interface WorkspaceField {
  field_key: string
  label: string
  value: string | number | null
  found: boolean
  required: boolean
  basis: 'stated' | 'inferred' | null
  /** The model's confidence in the value, 0 to 1. */
  confidence: number
  score: number
  /** Why the score was held down (caps applied while scoring). */
  concerns: string[]
  needs_decision: boolean
  span: WorkspaceSpan | null
  coding: WorkspaceCoding | null
  /** Systems a code can be chosen from for this field, or null when it is not coded. */
  codeable: { system: CodeSystem; secondary?: CodeSystem } | null
  kind: AttributeKind
  /** The allowed answers for fixed-choice fields. */
  choices: readonly string[] | null
}

export interface WorkspaceIssue {
  severity: 'error' | 'warning'
  path: string
  message: string
  ruleId: string
}

export interface WorkspaceResource {
  id: string
  resource_type: string
  validation_status: 'pass' | 'fail' | 'pending'
  validation_issues: WorkspaceIssue[]
  score: number | null
  threshold: number | null
  flags: string[]
  fields: WorkspaceField[]
}

export interface WorkspacePage {
  page: number
  text: string
}

export interface ReviewWorkspace {
  task: { id: string; kind: ReviewKind; lock_expires_at: string | null; held_by_me: boolean }
  record: {
    id: string
    doc_type: DocType
    status: RecordStatus
    status_reason: string | null
    ocr_confidence: number | null
    source: { id: string; name: string }
  }
  document: { signed_url: string | null; mime_type: string | null; pages: WorkspacePage[] }
  decision: {
    aggregate_score: number
    reasons: string[]
    reasoning_trace: string
    thresholds_applied: Record<string, { threshold: number; version: number; score: number; pass: boolean }>
  } | null
  consent: { result: string; checked_at: string } | null
  resources: WorkspaceResource[]
}

export interface ReviewSubmitResult {
  status: 'committed' | 'rejected'
  fhir_resource_ids?: string[]
}

export interface TerminologyHit {
  system: CodeSystem
  code: string
  display: string
  score: number
}
