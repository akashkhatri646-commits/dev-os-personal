'use client'

import { useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useMemo, useState, type ReactNode } from 'react'
import { DataTable } from '@/components/shared/DataTable'
import { PageHeader } from '@/components/shared/PageHeader'
import { SelectField } from '@/components/ui/fields'
import { fetchDashboard } from '@/lib/api/metrics'
import { queryKeys } from '@/lib/api/queryKeys'
import { cn } from '@/lib/utils/cn'
import type { SourceMetrics } from '@/types/metrics'

const WINDOWS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
]

/** Below this many samples a rate is shown with a caution: one record moves it a long way. */
const SMALL_SAMPLE = 30

const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(value < 0.1 && value > 0 ? 1 : 0)}%`)
const money = (value: number | null) => (value === null ? '—' : `$${value.toFixed(value < 1 ? 3 : 2)}`)
const duration = (seconds: number | null) => (seconds === null ? '—' : seconds < 90 ? `${Math.round(seconds)} s` : `${(seconds / 60).toFixed(1)} min`)
const age = (minutes: number | null) => (minutes === null ? null : minutes < 60 ? `${minutes} min` : minutes < 2880 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 1440)} d`)
const timeFormatter = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })

function Tile({ label, value, detail, tone }: { label: string; value: ReactNode; detail?: ReactNode; tone?: 'danger' | 'warning' }) {
  return (
    <div className={cn('flex flex-col gap-1 rounded-lg border bg-bg-primary p-4', tone === 'danger' ? 'border-danger-border bg-danger-bg' : tone === 'warning' ? 'border-warning-border bg-warning-bg' : 'border-border')}>
      <span className="text-body-sm text-text-secondary">{label}</span>
      <span className={cn('text-h5', tone === 'danger' ? 'text-danger-text' : 'text-text-primary')}>{value}</span>
      {detail && <span className="text-body-sm text-text-secondary">{detail}</span>}
    </div>
  )
}

/** A rate with the numbers behind it, so a percentage is never shown without its sample size. */
function Rate({ rate, part, whole, interval }: { rate: number | null; part: number; whole: number; interval?: [number, number] | null }) {
  if (whole === 0) return <span className="text-text-secondary">No data</span>
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-text-primary">{percent(rate)}</span>
      <span className="text-body-sm text-text-secondary">
        {part} of {whole}
      </span>
      {interval && <span className="text-body-sm text-text-secondary">95% range {percent(interval[0])} to {percent(interval[1])}</span>}
      {whole < SMALL_SAMPLE && <span className="text-body-sm text-warning-text">Small sample</span>}
    </div>
  )
}

export function DashboardView() {
  const [days, setDays] = useState<7 | 30 | 90>(30)
  const query = useQuery({
    queryKey: queryKeys.dashboard(days),
    queryFn: () => fetchDashboard(days),
    refetchInterval: 60_000,
  })
  const data = query.data

  const columns = useMemo<ColumnDef<SourceMetrics, unknown>[]>(
    () => [
      {
        id: 'source',
        header: 'Source',
        accessorKey: 'source_name',
        cell: ({ row }) => (
          <div className="flex flex-col items-start gap-1">
            <Link href={`/sources/${row.original.source_id}`} className="text-brand hover:underline">
              {row.original.source_name}
            </Link>
            <span className={row.original.paused ? 'badge-warning' : row.original.auto_commit_enabled ? 'badge-success' : 'badge-neutral'}>
              {row.original.paused ? 'Paused' : row.original.auto_commit_enabled ? 'Auto-commit on' : 'Manual review'}
            </span>
          </div>
        ),
      },
      { id: 'records', header: 'Records', accessorKey: 'records', cell: ({ row }) => <span className="text-text-primary">{row.original.records}</span> },
      { id: 'stp', header: 'Committed without review', accessorKey: 'stp_rate', cell: ({ row }) => <Rate rate={row.original.stp_rate} part={row.original.stp_count} whole={row.original.records} /> },
      { id: 'precision', header: 'Escalations that needed a change', accessorKey: 'escalation_precision', cell: ({ row }) => <Rate rate={row.original.escalation_precision} part={row.original.review_changed} whole={row.original.escalated_reviewed} /> },
      {
        id: 'holdback',
        header: 'Audit-sample error rate',
        accessorKey: 'holdback_error_rate',
        cell: ({ row }) => <Rate rate={row.original.holdback_error_rate} part={row.original.holdback_changed} whole={row.original.holdback_samples} interval={row.original.holdback_ci} />,
      },
      { id: 'review', header: 'Review time', accessorKey: 'mean_review_seconds', cell: ({ row }) => <span className="text-text-primary">{duration(row.original.mean_review_seconds)}</span> },
      {
        id: 'queue',
        header: 'Waiting now',
        accessorKey: 'queue_depth',
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="text-text-primary">{row.original.queue_depth}</span>
            {age(row.original.oldest_open_minutes) && <span className="text-body-sm text-text-secondary">oldest {age(row.original.oldest_open_minutes)}</span>}
          </div>
        ),
      },
      { id: 'cost', header: 'Cost per record', accessorKey: 'cost_per_record', cell: ({ row }) => <span className="text-text-primary">{money(row.original.cost_per_record)}</span> },
      {
        id: 'errors',
        header: 'Downstream errors',
        accessorKey: 'downstream_errors',
        cell: ({ row }) => (
          <div className="flex flex-col items-start gap-1">
            <span className={row.original.downstream_errors > 0 ? 'badge-danger' : 'badge-success'}>{row.original.downstream_errors}</span>
            {row.original.open_incidents > 0 && <span className="text-body-sm text-danger-text">{row.original.open_incidents} open</span>}
          </div>
        ),
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description="How each source is doing. Every rate shows the number of records behind it, and there is no single blended accuracy figure: read the table below the tiles."
        actions={
          <button type="button" className="btn-secondary" onClick={() => void query.refetch()} disabled={query.isFetching}>
            <RefreshCw aria-hidden="true" className={cn('h-4 w-4', query.isFetching && 'animate-spin')} />
            Refresh
          </button>
        }
      />

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="w-52">
          <SelectField label="Period" options={WINDOWS} value={String(days)} onChange={(event) => setDays(Number(event.target.value) as 7 | 30 | 90)} />
        </div>
        {data && <span className="text-body-sm text-text-secondary">Updated {timeFormatter.format(new Date(data.generated_at))}</span>}
      </div>

      {data && (
        <section aria-label="Key numbers" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <Tile label="Records processed" value={data.totals.records} detail={`in the last ${data.days} days`} />
          <Tile label="Committed without review" value={percent(data.totals.stp_rate)} detail={data.totals.records > 0 ? `${data.totals.stp_count} of ${data.totals.records}` : 'No records yet'} />
          <Tile label="Waiting for review" value={data.totals.queue_depth} detail={age(data.totals.oldest_open_minutes) ? `oldest ${age(data.totals.oldest_open_minutes)}` : 'Queue is empty'} tone={data.totals.oldest_open_minutes !== null && data.totals.oldest_open_minutes > 1440 ? 'warning' : undefined} />
          <Tile label="Downstream errors" value={data.totals.downstream_errors} detail={data.totals.open_incidents > 0 ? `${data.totals.open_incidents} still open` : data.totals.downstream_errors > 0 ? 'All resolved' : 'None reported'} tone={data.totals.downstream_errors > 0 ? 'danger' : undefined} />
          <Tile label="Model cost per record" value={money(data.totals.cost_per_record)} detail={`${money(data.totals.cost_usd)} in total, model only`} />
          <Tile label="Accuracy against labeled data" value="Not measured" detail="Needs the evaluation feature" />
        </section>
      )}

      <section className="flex flex-col gap-2" aria-label="Sources">
        <h2 className="text-h5 text-text-primary">By source</h2>
        <DataTable
          caption={`Per-source results for the last ${days} days`}
          columns={columns}
          data={data?.sources ?? []}
          getRowId={(source) => source.source_id}
          isLoading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          emptyTitle="No sources yet"
          emptyDescription="Sources appear here once they are created."
        />
      </section>

      <section className="max-w-3xl rounded-md border border-border bg-bg-surface px-4 py-3 text-body-sm text-text-secondary" aria-label="How to read this page">
        <p>
          <span className="text-text-primary">Committed without review</span> counts auto-committed records that were not picked as an audit sample, out of all records that have settled. <span className="text-text-primary">Audit-sample error rate</span> is how often a reviewer changed a record the system would have committed by itself: the honest check on automatic commits. With few samples the range is wide; trust it only as the count grows.
        </p>
        <p className="mt-2">
          Not shown yet: accuracy against labeled data, daily trends, segment breakdowns, the north-star cost including reviewer time, and automatic alerts and threshold proposals. They need the evaluation and calibration work.
        </p>
      </section>
    </div>
  )
}
