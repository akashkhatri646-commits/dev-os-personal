'use client'

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Loader2, RefreshCw, Wifi, WifiOff } from 'lucide-react'
import Link from 'next/link'
import { useMemo } from 'react'
import { RoleGate } from '@/components/layout/RoleGate'
import { DataTable } from '@/components/shared/DataTable'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { useToast } from '@/components/ui/Toaster'
import { useCurrentUser } from '@/hooks/useRole'
import { useRealtimeRecords } from '@/hooks/useRealtimeRecords'
import { ApiError } from '@/lib/api/errors'
import { fetchRecordsPage, retryRecord } from '@/lib/api/ingestions'
import { queryKeys } from '@/lib/api/queryKeys'
import { isRetryable, reasonLabel } from '@/lib/records/reasons'
import type { RecordSummary } from '@/types/records'

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const DOC_LABEL = { discharge_summary: 'Discharge summary', lab_report: 'Lab report', other: 'Other' } as const
const KIND_LABEL = { pdf: 'PDF', image: 'Image', hl7v2: 'HL7v2', text: 'Text' } as const
const POLL_MS = 10_000

export function RecentSubmissions() {
  const { orgId } = useCurrentUser()
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.records })
  const { connected } = useRealtimeRecords(orgId, refresh)

  const query = useInfiniteQuery({
    queryKey: queryKeys.records,
    queryFn: ({ pageParam }) => fetchRecordsPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // Poll only while the realtime channel is down.
    refetchInterval: connected ? false : POLL_MS,
  })
  const records = useMemo(() => query.data?.pages.flatMap((page) => page.records) ?? [], [query.data])

  const retry = useMutation({
    mutationFn: retryRecord,
    onSuccess: () => {
      refresh()
      toast({ title: 'Retry queued', description: 'The record will be processed again shortly.', tone: 'success' })
    },
    onError: (error) =>
      toast({
        title: 'Could not retry',
        description: error instanceof ApiError ? error.message : 'Try again shortly.',
        tone: 'danger',
      }),
  })

  const columns = useMemo<ColumnDef<RecordSummary, unknown>[]>(
    () => [
      {
        id: 'submitted',
        header: 'Submitted',
        accessorKey: 'created_at',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-text-secondary">
            {dateFormatter.format(new Date(row.original.created_at))}
          </span>
        ),
      },
      {
        id: 'source',
        header: 'Source',
        accessorKey: 'source_name',
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <span className="text-text-primary">{row.original.source_name ?? 'Unknown source'}</span>
            <span className="text-body-sm text-text-secondary">
              {DOC_LABEL[row.original.doc_type]} · {KIND_LABEL[row.original.input_kind]}
            </span>
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        accessorKey: 'status',
        cell: ({ row }) => {
          const label = reasonLabel(row.original.status_reason)
          return (
            <div className="flex flex-col items-start gap-1">
              <StatusBadge status={row.original.status} reason={row.original.status_reason} />
              {label && <span className="text-body-sm text-text-secondary">{label}</span>}
            </div>
          )
        },
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-3">
            {isRetryable(row.original.status, row.original.status_reason) && (
              <RoleGate allow={['integration_engineer', 'admin']}>
                <button
                  type="button"
                  className="btn-secondary px-3 py-1"
                  disabled={retry.isPending && retry.variables === row.original.id}
                  onClick={(event) => {
                    event.stopPropagation()
                    retry.mutate(row.original.id)
                  }}
                >
                  {retry.isPending && retry.variables === row.original.id ? (
                    <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw aria-hidden="true" className="h-3 w-3" />
                  )}
                  Retry
                </button>
              </RoleGate>
            )}
            <Link
              href={`/records/${row.original.id}`}
              onClick={(event) => event.stopPropagation()}
              className="text-body-sm text-brand hover:underline"
            >
              Details
            </Link>
          </div>
        ),
      },
    ],
    [retry],
  )

  return (
    <section className="flex flex-col gap-3" aria-labelledby="recent-submissions">
      <div className="flex items-center justify-between gap-2">
        <h2 id="recent-submissions" className="text-h5 text-text-primary">
          Recent submissions
        </h2>
        <span
          className="inline-flex items-center gap-1 text-body-sm text-text-secondary"
          role="status"
          aria-live="polite"
        >
          {connected ? (
            <Wifi aria-hidden="true" className="h-3 w-3" />
          ) : (
            <WifiOff aria-hidden="true" className="h-3 w-3" />
          )}
          {connected ? 'Live updates' : 'Reconnecting, refreshing every 10 seconds'}
        </span>
      </div>
      <DataTable
        caption="Recent submissions"
        columns={columns}
        data={records}
        getRowId={(record) => record.id}
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyTitle="No records yet"
        emptyDescription="Submit a discharge summary to start the pipeline."
        hasMore={query.hasNextPage}
        onLoadMore={() => void query.fetchNextPage()}
        isLoadingMore={query.isFetchingNextPage}
      />
    </section>
  )
}
