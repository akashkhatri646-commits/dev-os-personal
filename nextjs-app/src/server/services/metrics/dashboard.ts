import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { computeSourceMetrics, computeTotals, type MetricIncident, type MetricRecord, type MetricTask } from '@/server/services/metrics/compute'
import type { AuthUser } from '@/types/domain'
import type { DashboardData } from '@/types/metrics'

const PAGE = 1000
const MAX_ROWS = 50_000

interface Page<T> {
  data: T[] | null
  error: { message: string } | null
}

/** Reads every row of a query, a page at a time (the API returns at most 1,000 rows per request). */
async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<Page<T>>): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw new AppError('INTERNAL', 'Failed to load dashboard data.', { cause: error })
    rows.push(...(data ?? []))
    if ((data ?? []).length < PAGE) break
  }
  return rows
}

/** A to-one embedded relation arrives as an object (a one-element array in some client versions). */
const embedded = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (Array.isArray(value) ? value[0] : value), schema)

const sourceRef = embedded(z.object({ source_id: z.string() }))

const taskRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  created_at: z.string(),
  claimed_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  ingestion_records: sourceRef,
})

const recordRowSchema = z.object({ source_id: z.string(), status: z.string(), holdback: z.boolean(), cost_usd: z.coerce.number() })
const incidentRowSchema = z.object({ status: z.string(), ingestion_records: sourceRef })

const toTask = (row: z.infer<typeof taskRowSchema>): MetricTask => ({
  id: row.id,
  source_id: row.ingestion_records.source_id,
  kind: row.kind,
  status: row.status,
  created_at: row.created_at,
  claimed_at: row.claimed_at,
  completed_at: row.completed_at,
})

const TASK_COLUMNS = 'id, kind, status, created_at, claimed_at, completed_at, ingestion_records!inner(source_id)'

/**
 * Operational numbers per source over the last `days` days, computed from the base tables on each
 * request (counts and timings only, no patient data). Safe for every role. Accuracy against labeled
 * data, calibration and alerts need the evaluation and calibration features and are not included.
 */
export async function getDashboard(actor: AuthUser, days: number): Promise<DashboardData> {
  const admin = getSupabaseAdmin()
  const now = Date.now()
  const from = new Date(now - days * 86_400_000).toISOString()

  const { data: sourceRows, error: sourceError } = await admin.from('provider_sources').select('id, name, auto_commit_enabled, pause_reason').eq('org_id', actor.orgId).order('name')
  if (sourceError) throw new AppError('INTERNAL', 'Failed to load sources.', { cause: sourceError })
  const sources = (sourceRows ?? []) as { id: string; name: string; auto_commit_enabled: boolean; pause_reason: string | null }[]
  const sourceIds = sources.map((source) => source.id)

  const [records, completed, open, corrections, incidents, openIncidents] = await Promise.all([
    fetchAll<unknown>((a, b) =>
      admin.from('ingestion_records').select('source_id, status, holdback, cost_usd').eq('org_id', actor.orgId).gte('created_at', from).order('created_at').range(a, b),
    ),
    fetchAll<unknown>((a, b) =>
      admin.from('review_tasks').select(TASK_COLUMNS).eq('ingestion_records.org_id', actor.orgId).eq('status', 'completed').gte('completed_at', from).order('created_at').range(a, b),
    ),
    fetchAll<unknown>((a, b) =>
      admin.from('review_tasks').select(TASK_COLUMNS).eq('ingestion_records.org_id', actor.orgId).in('status', ['open', 'claimed']).order('created_at').range(a, b),
    ),
    sourceIds.length === 0
      ? Promise.resolve([] as unknown[])
      : fetchAll<unknown>((a, b) => admin.from('review_corrections').select('task_id').in('source_id', sourceIds).gte('reviewed_at', from).neq('action', 'accept').order('reviewed_at').range(a, b)),
    fetchAll<unknown>((a, b) =>
      admin.from('downstream_errors').select('status, ingestion_records!inner(source_id)').eq('org_id', actor.orgId).gte('created_at', from).order('created_at').range(a, b),
    ),
    fetchAll<unknown>((a, b) =>
      admin.from('downstream_errors').select('status, ingestion_records!inner(source_id)').eq('org_id', actor.orgId).neq('status', 'resolved').order('created_at').range(a, b),
    ),
  ])

  const completedTasks = z.array(taskRowSchema).parse(completed).map(toTask)
  const toIncident = (row: z.infer<typeof incidentRowSchema>): MetricIncident => ({ source_id: row.ingestion_records.source_id, status: row.status })

  const perSource = computeSourceMetrics({
    sources,
    records: z.array(recordRowSchema).parse(records) satisfies MetricRecord[],
    completedTasks,
    openTasks: z.array(taskRowSchema).parse(open).map(toTask),
    changedTaskIds: new Set(z.array(z.object({ task_id: z.string() })).parse(corrections).map((row) => row.task_id)),
    incidents: z.array(incidentRowSchema).parse(incidents).map(toIncident),
    openIncidents: z.array(incidentRowSchema).parse(openIncidents).map(toIncident),
    now,
  })
  return { generated_at: new Date(now).toISOString(), from, days, totals: computeTotals(perSource, completedTasks), sources: perSource }
}
