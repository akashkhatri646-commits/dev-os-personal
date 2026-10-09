import type { DocType } from '@/types/domain'
import type { EvalBasis } from '@/types/evaluation'

export type SourceStatus = 'manual_only' | 'auto_commit' | 'paused'
export type EvalStatus = 'none' | 'passed' | 'failed'
export type SizeClass = 'small' | 'medium' | 'large'
export type ProviderType = 'hospital' | 'lab' | 'clinic'

export interface SourceSummary {
  id: string
  name: string
  provider_type: ProviderType
  size_class: SizeClass
  region: string | null
  primary_language: string
  doc_types: DocType[]
  auto_commit_enabled: boolean
  pause_reason: string | null
  eval_status: EvalStatus
  /** The kind of data a passed evaluation covered. */
  eval_basis: EvalBasis | null
  holdback_pct: number
  flagged_poor: boolean
  status: SourceStatus
  queue_depth: number
  /** Active threshold per resource key (`*` = default). */
  thresholds: Record<string, number>
  created_at: string
}

export interface ThresholdVersion {
  resource_type: string
  threshold: number
  version: number
  active: boolean
  reason: string
  changed_by: string | null
  created_at: string
}

export interface SourceDetail extends SourceSummary {
  consent_regime: 'abdm' | 'hipaa'
  eval_passed_at: string | null
  key_prefix: string | null
  thresholds_detail: ThresholdVersion[]
  latest_eval: { passed: boolean; ran_at: string; sample_count: number } | null
}

export interface CreatedSource {
  id: string
  /** Plaintext API key, returned exactly once at creation or rotation. */
  api_key: string
}
