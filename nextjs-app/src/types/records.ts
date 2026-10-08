import type { DocType, InputKind, RecordStatus } from '@/types/domain'

export interface RecordSummary {
  id: string
  source_id: string
  source_name: string | null
  doc_type: DocType
  input_kind: InputKind
  status: RecordStatus
  status_reason: string | null
  created_at: string
  completed_at: string | null
}

export interface SubmissionResult {
  record_id: string
  status: RecordStatus
  duplicate: boolean
  /** Every record created or matched by the submission (more than one for an HL7v2 batch). */
  record_ids: string[]
}

export interface RecordEvent {
  event: string
  created_at: string
  payload: Record<string, unknown>
}

export interface RecordDetail extends RecordSummary {
  data_categories: string[]
  cost_usd: number
  latency_ms: number | null
  document: { mime_type: string; bytes: number; page_count: number | null; ocr_confidence: number | null; ocr_engine: string | null } | null
  consent: { result: string; regime: string; required_categories: string[]; matched_scope: string[]; checked_at: string } | null
  events: RecordEvent[]
}
