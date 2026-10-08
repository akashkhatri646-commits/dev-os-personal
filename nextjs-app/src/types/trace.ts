import type { AuditRow } from '@/types/auditApi'
import type { DocType, InputKind, RecordStatus } from '@/types/domain'
import type { ReviewWorkspace, WorkspaceResource } from '@/types/review'

/** One FHIR resource of a record, committed or still a draft. */
export interface RecordFhirResource {
  id: string
  resource_type: string
  /** False while the resource is only a draft built by the pipeline. */
  committed: boolean
  version_id: number | null
  resource: Record<string, unknown>
}

export interface ProvenanceView {
  resource_id: string
  resource_type: string
  extraction_method: 'ai_extracted_auto' | 'ai_extracted_human_reviewed' | string
  model_id: string | null
  prompt_versions: Record<string, string>
  reviewer_name: string | null
  consent_artifact_ref: string | null
  committed_at: string
  field_count: number
}

/** What the record page shows beyond the summary: fields, FHIR resources, routing decision, provenance. */
export interface RecordTrace {
  resources: WorkspaceResource[]
  fhir: RecordFhirResource[]
  decision: ReviewWorkspace['decision']
  provenance: ProvenanceView[]
}

export interface ReconstructionCorrection {
  field_key: string
  action: 'accept' | 'correct' | 'reject'
  original_value: unknown
  corrected_value: unknown
  original_code: unknown
  corrected_code: unknown
  note: string | null
  reviewer_name: string | null
  reviewed_at: string
}

/** "Why was this record committed or escalated": the audit chain joined with what each stage stored. */
export interface Reconstruction {
  record: {
    id: string
    status: RecordStatus
    status_reason: string | null
    doc_type: DocType
    input_kind: InputKind
    source: { id: string; name: string }
    created_at: string
    completed_at: string | null
    cost_usd: number
    latency_ms: number | null
    holdback: boolean
  }
  consent: { result: string; regime: string; required: string[]; matched_scope: string[]; checked_at: string; artifact_ref: string | null } | null
  ocr: { engine: string | null; confidence: number | null; pages: number | null } | null
  extraction: { model_id: string | null; prompt_versions: Record<string, string>; fields_found: number | null; fields_not_found: number | null; injection_suspected: boolean } | null
  mapping: { resources: number | null; coded: number | null; uncoded: number | null } | null
  validation: { resource_type: string; status: string; error_count: number; flags: string[] }[]
  scores: { aggregate: number | null; resources: { resource_type: string; score: number; threshold: number | null; pass: boolean | null }[] }
  routing: { decision: string; reasons: string[]; trace: string; rule_version: string } | null
  review: {
    tasks: { kind: string; status: string; claimed_by_name: string | null; claimed_at: string | null; completed_at: string | null }[]
    corrections: ReconstructionCorrection[]
  }
  commit: { mode: string; resource_ids: string[]; committed_at: string } | null
  chain: AuditRow[]
}
