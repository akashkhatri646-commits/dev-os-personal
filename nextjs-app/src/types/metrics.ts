/** One source's operational numbers over a window. Every rate comes with the count it was computed from. */
export interface SourceMetrics {
  source_id: string
  source_name: string
  auto_commit_enabled: boolean
  paused: boolean
  /** Records that have settled (committed, in review, rejected or failed); blocked-consent records are counted separately. */
  records: number
  /** Auto-committed records that were not picked as an audit sample. */
  stp_count: number
  /** stp_count / records, or null with no records. */
  stp_rate: number | null
  /** Escalated records a reviewer has finished. */
  escalated_reviewed: number
  /** Of those, how many the reviewer corrected or rejected a field in. */
  review_changed: number
  escalation_precision: number | null
  /** Audit samples a reviewer has finished: the unbiased check on the auto-commit path. */
  holdback_samples: number
  holdback_changed: number
  holdback_error_rate: number | null
  /** 95 % Wilson interval for the audit-sample error rate. */
  holdback_ci: [number, number] | null
  mean_review_seconds: number | null
  /** Tasks open or claimed right now (not limited to the window). */
  queue_depth: number
  oldest_open_minutes: number | null
  cost_usd: number
  cost_per_record: number | null
  downstream_errors: number
  open_incidents: number
  failed: number
  blocked_consent: number
}

export interface DashboardTotals {
  records: number
  stp_count: number
  stp_rate: number | null
  queue_depth: number
  oldest_open_minutes: number | null
  cost_usd: number
  cost_per_record: number | null
  downstream_errors: number
  open_incidents: number
  mean_review_seconds: number | null
  /** Number of sources that have an evaluation against labeled data (none are measured yet). */
  sources_with_gold_accuracy: number
}

export interface DashboardData {
  generated_at: string
  from: string
  days: number
  totals: DashboardTotals
  sources: SourceMetrics[]
}
