'use client'

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Loader2, PlayCircle } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { DataTable } from '@/components/shared/DataTable'
import { PageHeader } from '@/components/shared/PageHeader'
import { SelectField } from '@/components/ui/fields'
import { useToast } from '@/components/ui/Toaster'
import { useRole } from '@/hooks/useRole'
import { ApiError } from '@/lib/api/errors'
import { queryKeys } from '@/lib/api/queryKeys'
import { claimReviewTask, fetchReviewTasks, type ReviewTaskFilters } from '@/lib/api/review'
import { reasonLabel } from '@/lib/records/reasons'
import { RESOURCE_LABELS } from '@/lib/review/labels'
import type { ReviewTaskSummary } from '@/types/review'

const STATUS_OPTIONS = [
  { value: 'open', label: 'Waiting for a reviewer' },
  { value: 'claimed', label: 'Being reviewed' },
]

const RESOURCE_OPTIONS = [
  { value: '', label: 'All record parts' },
  ...Object.entries(RESOURCE_LABELS).map(([value, label]) => ({ value, label })),
]

function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  if (minutes < 60 * 48) return `${Math.floor(minutes / 60)} h`
  return `${Math.floor(minutes / (60 * 24))} d`
}

/** Higher priority tasks are marked with text as well as a colour. */
function priorityBadge(priority: number) {
  if (priority >= 130) return <span className="badge-danger">High</span>
  if (priority >= 90) return <span className="badge-warning">Medium</span>
  return <span className="badge-neutral">Normal</span>
}

export function ReviewQueueView() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const role = useRole()
  const [filters, setFilters] = useState<ReviewTaskFilters>({ status: 'open', mine: false })
  const [claiming, setClaiming] = useState<string | null>(null)

  const query = useInfiniteQuery({
    queryKey: queryKeys.reviewTasks(filters),
    queryFn: ({ pageParam }) => fetchReviewTasks(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: 30_000,
  })
  const tasks = useMemo(() => query.data?.pages.flatMap((page) => page.tasks) ?? [], [query.data])

  async function open(task: ReviewTaskSummary) {
    if (claiming) return
    // A downstream-error review is about committed data: it opens the record, it is not claimed.
    if (task.kind === 'downstream_error_review') {
      router.push(`/records/${task.record_id}`)
      return
    }
    setClaiming(task.id)
    try {
      // A task of your own is simply reopened (claiming it again is harmless); one another reviewer
      // holds can only be viewed, by an admin.
      if (task.status === 'open' || task.claimed_by_me) await claimReviewTask(task.id)
      router.push(`/review/${task.id}`)
    } catch (error) {
      setClaiming(null)
      if (error instanceof ApiError && error.details && typeof error.details === 'object' && 'reason' in error.details) {
        void queryClient.invalidateQueries({ queryKey: ['review-tasks'] })
      }
      toast({ title: 'Could not open this task', description: error instanceof ApiError ? error.message : 'Try again.', tone: 'danger' })
    }
  }

  const nextOpen = tasks.find((task) => task.status === 'open')

  const columns = useMemo<ColumnDef<ReviewTaskSummary, unknown>[]>(
    () => [
      { id: 'priority', header: 'Priority', accessorKey: 'priority', cell: ({ row }) => priorityBadge(row.original.priority) },
      {
        id: 'source',
        header: 'Source',
        accessorKey: 'source_name',
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="text-text-primary">{row.original.source_name}</span>
            <span className="text-body-sm text-text-secondary">{row.original.doc_type.replaceAll('_', ' ')}</span>
          </div>
        ),
      },
      {
        id: 'reasons',
        header: 'Why it is here',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.reasons.length === 0 && <span className="text-body-sm text-text-secondary">Needs a check</span>}
            {row.original.reasons.map((reason) => (
              <span key={reason} className="badge-neutral">
                {reasonLabel(reason)}
              </span>
            ))}
            {role === 'admin' && row.original.kind === 'holdback_audit' && <span className="badge-info">Audit sample</span>}
            {row.original.kind === 'downstream_error_review' && <span className="badge-danger">Downstream error</span>}
          </div>
        ),
      },
      {
        id: 'parts',
        header: 'Record parts',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-body-sm text-text-secondary">
            {row.original.resource_types.map((type) => RESOURCE_LABELS[type] ?? type).join(', ') || 'None built'}
          </span>
        ),
      },
      {
        id: 'score',
        header: 'Lowest score',
        accessorKey: 'min_field_score',
        cell: ({ row }) => (
          <span className="text-body-sm">{row.original.min_field_score === null ? 'Not scored' : `${Math.round(row.original.min_field_score * 100)}%`}</span>
        ),
      },
      { id: 'age', header: 'Waiting', accessorKey: 'age_minutes', cell: ({ row }) => <span className="whitespace-nowrap text-body-sm">{formatAge(row.original.age_minutes)}</span> },
      {
        id: 'holder',
        header: 'Reviewer',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-body-sm text-text-secondary">
            {row.original.claimed_by_me ? 'You' : (row.original.claimed_by_name ?? '—')}
          </span>
        ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const task = row.original
          const mine = task.claimed_by_me
          const label = task.kind === 'downstream_error_review' ? 'Open record' : task.status === 'open' ? 'Review' : mine ? 'Continue' : role === 'admin' ? 'View' : null
          if (!label) return null
          return (
            <button
              type="button"
              className="btn-secondary px-3 py-1"
              disabled={claiming !== null}
              onClick={(event) => {
                event.stopPropagation()
                void open(task)
              }}
            >
              {claiming === task.id && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
              {label}
            </button>
          )
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [claiming, role],
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Review queue"
        description="Records the pipeline could not commit on its own. Open one to check each field against the source, correct what is wrong and approve."
        actions={
          <button type="button" className="btn-primary" disabled={!nextOpen || claiming !== null} onClick={() => nextOpen && void open(nextOpen)}>
            <PlayCircle aria-hidden="true" className="h-4 w-4" />
            Claim next
          </button>
        }
      />

      <div className="flex flex-wrap items-end gap-4">
        <div className="w-60">
          <SelectField label="Show" options={STATUS_OPTIONS} value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value as 'open' | 'claimed' })} />
        </div>
        <div className="w-52">
          <SelectField
            label="Record part"
            options={RESOURCE_OPTIONS}
            value={filters.resourceType ?? ''}
            onChange={(event) => setFilters({ ...filters, resourceType: event.target.value || undefined })}
          />
        </div>
        <label className="flex items-center gap-2 pb-2 text-body-lg text-text-primary">
          <input type="checkbox" checked={filters.mine} onChange={(event) => setFilters({ ...filters, mine: event.target.checked })} />
          Mine only
        </label>
      </div>

      <DataTable
        caption="Records waiting for review"
        columns={columns}
        data={tasks}
        getRowId={(task) => task.id}
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyTitle={filters.status === 'open' ? 'The queue is empty' : 'No tasks are being reviewed'}
        emptyDescription="Records that need a person appear here when automation cannot commit them."
        hasMore={query.hasNextPage}
        onLoadMore={() => void query.fetchNextPage()}
        isLoadingMore={query.isFetchingNextPage}
      />
    </div>
  )
}
