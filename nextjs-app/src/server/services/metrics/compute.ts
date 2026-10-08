import type { DashboardTotals, SourceMetrics } from '@/types/metrics'

/** Records that have settled. In-flight records would distort every rate, and blocked-consent ones are not "ingested". */
export const SETTLED_STATUSES = ['auto_committed', 'committed', 'needs_review', 'in_review', 'rejected', 'failed']

/** 95 % Wilson score interval for a share: honest about small samples where a plain percentage is not. */
export function wilsonInterval(successes: number, total: number): [number, number] | null {
  if (total <= 0) return null
  const z = 1.959964
  const p = successes / total
  const denominator = 1 + (z * z) / total
  const centre = (p + (z * z) / (2 * total)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator
  return [Math.max(0, Math.round((centre - margin) * 10_000) / 10_000), Math.min(1, Math.round((centre + margin) * 10_000) / 10_000)]
}

export interface MetricRecord {
  source_id: string
  status: string
  holdback: boolean
  cost_usd: number
}

export interface MetricTask {
  id: string
  source_id: string
  kind: string
  status: string
  created_at: string
  claimed_at: string | null
  completed_at: string | null
}

export interface MetricIncident {
  source_id: string
  status: string
}

export interface MetricSource {
  id: string
  name: string
  auto_commit_enabled: boolean
  pause_reason: string | null
}

export interface MetricInput {
  sources: readonly MetricSource[]
  /** Records created in the window. */
  records: readonly MetricRecord[]
  /** Review tasks finished in the window. */
  completedTasks: readonly MetricTask[]
  /** Tasks open or claimed now. */
  openTasks: readonly MetricTask[]
  /** Task ids in which the reviewer corrected or rejected at least one field. */
  changedTaskIds: ReadonlySet<string>
  /** Downstream errors reported in the window. */
  incidents: readonly MetricIncident[]
  /** Downstream errors still open or being investigated, whenever they were reported. */
  openIncidents: readonly MetricIncident[]
  now: number
}

const rate = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null)
const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places

/** The per-source numbers, from base data. Pure, so the definitions are testable. */
export function computeSourceMetrics(input: MetricInput): SourceMetrics[] {
  return input.sources.map((source) => {
    const records = input.records.filter((record) => record.source_id === source.id)
    const settled = records.filter((record) => SETTLED_STATUSES.includes(record.status))
    const stp = settled.filter((record) => record.status === 'auto_committed' && !record.holdback).length
    const cost = records.reduce((total, record) => total + record.cost_usd, 0)

    const done = input.completedTasks.filter((task) => task.source_id === source.id)
    const escalated = done.filter((task) => task.kind === 'escalation')
    const samples = done.filter((task) => task.kind === 'holdback_audit')
    const escalatedChanged = escalated.filter((task) => input.changedTaskIds.has(task.id)).length
    const samplesChanged = samples.filter((task) => input.changedTaskIds.has(task.id)).length

    const durations = done
      .filter((task) => task.claimed_at && task.completed_at)
      .map((task) => (Date.parse(task.completed_at as string) - Date.parse(task.claimed_at as string)) / 1000)
      .filter((seconds) => seconds >= 0)

    const open = input.openTasks.filter((task) => task.source_id === source.id)
    const oldest = open.length > 0 ? Math.min(...open.map((task) => Date.parse(task.created_at))) : null

    return {
      source_id: source.id,
      source_name: source.name,
      auto_commit_enabled: source.auto_commit_enabled,
      paused: source.pause_reason !== null,
      records: settled.length,
      stp_count: stp,
      stp_rate: rate(stp, settled.length),
      escalated_reviewed: escalated.length,
      review_changed: escalatedChanged,
      escalation_precision: rate(escalatedChanged, escalated.length),
      holdback_samples: samples.length,
      holdback_changed: samplesChanged,
      holdback_error_rate: rate(samplesChanged, samples.length),
      holdback_ci: wilsonInterval(samplesChanged, samples.length),
      mean_review_seconds: durations.length > 0 ? round(durations.reduce((total, seconds) => total + seconds, 0) / durations.length, 1) : null,
      queue_depth: open.length,
      oldest_open_minutes: oldest === null ? null : Math.max(0, Math.floor((input.now - oldest) / 60_000)),
      cost_usd: round(cost, 4),
      cost_per_record: settled.length > 0 ? round(cost / settled.length, 4) : null,
      downstream_errors: input.incidents.filter((incident) => incident.source_id === source.id).length,
      open_incidents: input.openIncidents.filter((incident) => incident.source_id === source.id).length,
      failed: records.filter((record) => record.status === 'failed').length,
      blocked_consent: records.filter((record) => record.status === 'blocked_consent').length,
    }
  })
}

/** Totals across sources. Rates are recomputed from the summed counts, never averaged. */
export function computeTotals(sources: readonly SourceMetrics[], completedTasks: readonly MetricTask[]): DashboardTotals {
  const records = sources.reduce((total, source) => total + source.records, 0)
  const stp = sources.reduce((total, source) => total + source.stp_count, 0)
  const cost = sources.reduce((total, source) => total + source.cost_usd, 0)
  const oldest = sources.map((source) => source.oldest_open_minutes).filter((value): value is number => value !== null)
  const durations = completedTasks
    .filter((task) => task.claimed_at && task.completed_at)
    .map((task) => (Date.parse(task.completed_at as string) - Date.parse(task.claimed_at as string)) / 1000)
    .filter((seconds) => seconds >= 0)
  return {
    records,
    stp_count: stp,
    stp_rate: rate(stp, records),
    queue_depth: sources.reduce((total, source) => total + source.queue_depth, 0),
    oldest_open_minutes: oldest.length > 0 ? Math.max(...oldest) : null,
    cost_usd: round(cost, 4),
    cost_per_record: records > 0 ? round(cost / records, 4) : null,
    downstream_errors: sources.reduce((total, source) => total + source.downstream_errors, 0),
    open_incidents: sources.reduce((total, source) => total + source.open_incidents, 0),
    mean_review_seconds: durations.length > 0 ? round(durations.reduce((total, seconds) => total + seconds, 0) / durations.length, 1) : null,
    sources_with_gold_accuracy: 0,
  }
}
