/** Source evaluation from reviewer decisions (docs/specs/17-source-evaluation.md). */
export type EvalVerdict = 'insufficient_evidence' | 'failed' | 'passed'
export type EvalBasis = 'synthetic' | 'real'

export interface EvalBar {
  minRecords: number
  minFields: number
  /** Lower-bound accuracy for medication, allergy and lab fields. */
  targetHighRisk: number
  /** Lower-bound accuracy for all other fields. */
  targetOther: number
  targetCode: number
  minResourcesAtThreshold: number
}

/** A count of right answers out of a total, with the one-sided 95% lower bound used for pass/fail decisions. */
export interface Rate {
  correct: number
  total: number
  rate: number | null
  lower: number | null
}

export interface EvalCriterion {
  id: string
  label: string
  /** null: nothing to judge yet (no fields of that kind). */
  met: boolean | null
  detail: string
}

export interface EvalReport {
  generated_at: string
  period_days: number | null
  verdict: EvalVerdict
  bar: EvalBar
  evidence: {
    records: number
    fields: number
    records_all_accepted: number
    median_decision_seconds: number | null
  }
  accuracy: { overall: Rate; high_risk: Rate; other: Rate; code: Rate; stated: Rate; inferred: Rate }
  ungrounded: number
  by_resource_type: { resource_type: string; rate: Rate }[]
  by_field: { field: string; rate: Rate }[]
  calibration: { bucket: string; fields: number; mean_score: number; accuracy: number | null }[]
  threshold_curve: { resource_type: string; threshold: number; resources: number; rate: Rate }[]
  suggested_thresholds: { resource_type: string; threshold: number | null; reason: string }[]
  /** Resources in records randomly held back for review after auto-commit was on: the unbiased sample. */
  holdback: Rate | null
  criteria: EvalCriterion[]
}

export interface EvaluationView extends EvalReport {
  model_id: string | null
  /** The last passed run covered a different model than the one in use now. */
  stale: boolean
  last_run: { ran_at: string; passed: boolean; basis: EvalBasis | null; records: number } | null
}
