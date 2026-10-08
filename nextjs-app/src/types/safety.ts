export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical'
export type IncidentStatus = 'open' | 'investigating' | 'resolved'
export type RootCause = 'extraction' | 'mapping' | 'ocr' | 'threshold' | 'consent' | 'other'

/** A confirmed problem found downstream in data this system committed. */
export interface Incident {
  id: string
  record_id: string
  fhir_resource_id: string | null
  source_id: string
  source_name: string
  severity: IncidentSeverity
  status: IncidentStatus
  description: string
  /** True when reporting paused the source's auto-commit. */
  source_paused: boolean
  reported_by_name: string | null
  root_cause: RootCause | null
  resolution_note: string | null
  created_at: string
  resolved_at: string | null
}

export interface BulkReviewResult {
  created: number
  already_open: number
}

export interface PromptRollbackResult {
  component: 'extraction' | 'mapping'
  active_version: string
  previous_version: string
}
