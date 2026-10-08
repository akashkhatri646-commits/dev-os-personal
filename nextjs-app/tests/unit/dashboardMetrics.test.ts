import { describe, expect, it } from 'vitest'
import { computeSourceMetrics, computeTotals, wilsonInterval, type MetricInput, type MetricTask } from '@/server/services/metrics/compute'

const NOW = Date.parse('2026-10-08T12:00:00Z')
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

const record = (status: string, overrides: Record<string, unknown> = {}) => ({ source_id: 's1', status, holdback: false, cost_usd: 0.02, ...overrides })
const task = (id: string, kind: string, overrides: Partial<MetricTask> = {}): MetricTask => ({ id, source_id: 's1', kind, status: 'completed', created_at: iso(120), claimed_at: iso(70), completed_at: iso(60), ...overrides })

const input = (overrides: Partial<MetricInput> = {}): MetricInput => ({
  sources: [{ id: 's1', name: 'City Hospital', auto_commit_enabled: true, pause_reason: null }],
  records: [],
  completedTasks: [],
  openTasks: [],
  changedTaskIds: new Set(),
  incidents: [],
  openIncidents: [],
  now: NOW,
  ...overrides,
})

const only = (overrides: Partial<MetricInput>) => computeSourceMetrics(input(overrides))[0]!

describe('wilsonInterval', () => {
  it('is wide for a small sample and narrows as the sample grows', () => {
    const small = wilsonInterval(0, 10)!
    const large = wilsonInterval(0, 1000)!
    expect(small[0]).toBe(0)
    expect(small[1]).toBeGreaterThan(0.25)
    expect(large[1]).toBeLessThan(0.005)
  })

  it('stays inside 0 to 1 and brackets the observed share', () => {
    const [low, high] = wilsonInterval(30, 100)!
    expect(low).toBeLessThan(0.3)
    expect(high).toBeGreaterThan(0.3)
    expect(wilsonInterval(10, 10)![1]).toBe(1)
    expect(wilsonInterval(0, 0)).toBeNull()
  })
})

describe('computeSourceMetrics', () => {
  it('counts only settled records, and reports blocked and failed ones apart', () => {
    const result = only({ records: [record('auto_committed'), record('committed'), record('needs_review'), record('failed'), record('blocked_consent'), record('extracting')] })
    expect(result).toMatchObject({ records: 4, failed: 1, blocked_consent: 1 })
  })

  it('counts straight-through only for auto-commits that were not audit samples, out of all settled records', () => {
    const result = only({ records: [record('auto_committed'), record('auto_committed'), record('auto_committed', { holdback: true }), record('needs_review')] })
    expect(result).toMatchObject({ records: 4, stp_count: 2, stp_rate: 0.5 })
  })

  it('works out escalation precision from finished escalation reviews only', () => {
    const result = only({
      completedTasks: [task('a', 'escalation'), task('b', 'escalation'), task('c', 'escalation'), task('d', 'holdback_audit'), task('e', 'downstream_error_review')],
      changedTaskIds: new Set(['a', 'b', 'd']),
    })
    expect(result).toMatchObject({ escalated_reviewed: 3, review_changed: 2 })
    expect(result.escalation_precision).toBeCloseTo(0.6667, 3)
  })

  it('reports the audit-sample error rate with its interval, from audit samples only', () => {
    const result = only({ completedTasks: [task('a', 'holdback_audit'), task('b', 'holdback_audit'), task('c', 'holdback_audit'), task('d', 'holdback_audit'), task('x', 'escalation')], changedTaskIds: new Set(['a', 'x']) })
    expect(result).toMatchObject({ holdback_samples: 4, holdback_changed: 1, holdback_error_rate: 0.25 })
    expect(result.holdback_ci![0]).toBeLessThan(0.25)
    expect(result.holdback_ci![1]).toBeGreaterThan(0.25)
  })

  it('averages review time over tasks that were claimed and completed', () => {
    const result = only({ completedTasks: [task('a', 'escalation'), task('b', 'escalation', { claimed_at: iso(80), completed_at: iso(60) }), task('c', 'escalation', { claimed_at: null })] })
    // 10 minutes and 20 minutes
    expect(result.mean_review_seconds).toBe(900)
  })

  it('shows the live queue and the age of its oldest task', () => {
    const result = only({ openTasks: [task('a', 'escalation', { status: 'open', created_at: iso(30) }), task('b', 'escalation', { status: 'claimed', created_at: iso(300) })] })
    expect(result).toMatchObject({ queue_depth: 2, oldest_open_minutes: 300 })
    expect(only({}).oldest_open_minutes).toBeNull()
  })

  it('gives cost per settled record, and counts downstream errors and open incidents', () => {
    const result = only({
      records: [record('auto_committed'), record('committed'), record('blocked_consent', { cost_usd: 0 })],
      incidents: [{ source_id: 's1', status: 'open' }, { source_id: 's1', status: 'resolved' }, { source_id: 's2', status: 'open' }],
      openIncidents: [{ source_id: 's1', status: 'open' }],
    })
    expect(result.cost_usd).toBeCloseTo(0.04, 4)
    expect(result.cost_per_record).toBeCloseTo(0.02, 4)
    expect(result).toMatchObject({ downstream_errors: 2, open_incidents: 1 })
  })

  it('has no rates, and no division by zero, for a source with no activity', () => {
    expect(only({})).toMatchObject({ records: 0, stp_rate: null, escalation_precision: null, holdback_error_rate: null, holdback_ci: null, mean_review_seconds: null, cost_per_record: null, queue_depth: 0 })
  })

  it('shows whether a source is paused, and keeps sources apart', () => {
    const sources = [
      { id: 's1', name: 'A', auto_commit_enabled: false, pause_reason: 'incident' },
      { id: 's2', name: 'B', auto_commit_enabled: true, pause_reason: null },
    ]
    const [first, second] = computeSourceMetrics(input({ sources, records: [record('auto_committed', { source_id: 's2' })] }))
    expect(first).toMatchObject({ paused: true, records: 0 })
    expect(second).toMatchObject({ paused: false, records: 1, stp_count: 1 })
  })
})

describe('computeTotals', () => {
  it('recomputes rates from summed counts instead of averaging the sources', () => {
    const sources = computeSourceMetrics(
      input({
        sources: [
          { id: 's1', name: 'A', auto_commit_enabled: true, pause_reason: null },
          { id: 's2', name: 'B', auto_commit_enabled: true, pause_reason: null },
        ],
        records: [record('auto_committed'), ...Array.from({ length: 9 }, () => record('needs_review')), ...Array.from({ length: 10 }, () => record('auto_committed', { source_id: 's2' }))],
      }),
    )
    expect(sources.map((source) => source.stp_rate)).toEqual([0.1, 1])
    const totals = computeTotals(sources, [])
    expect(totals).toMatchObject({ records: 20, stp_count: 11, stp_rate: 0.55 })
    expect(totals.sources_with_gold_accuracy).toBe(0)
  })

  it('takes the oldest waiting task across sources and sums queues, incidents and cost', () => {
    const sources = computeSourceMetrics(
      input({
        sources: [
          { id: 's1', name: 'A', auto_commit_enabled: true, pause_reason: null },
          { id: 's2', name: 'B', auto_commit_enabled: true, pause_reason: null },
        ],
        openTasks: [task('a', 'escalation', { status: 'open', created_at: iso(10) }), task('b', 'escalation', { status: 'open', source_id: 's2', created_at: iso(500) })],
        openIncidents: [{ source_id: 's2', status: 'open' }],
        incidents: [{ source_id: 's2', status: 'open' }],
        records: [record('auto_committed'), record('auto_committed', { source_id: 's2' })],
      }),
    )
    expect(computeTotals(sources, [])).toMatchObject({ queue_depth: 2, oldest_open_minutes: 500, open_incidents: 1, downstream_errors: 1, cost_usd: 0.04 })
  })
})
