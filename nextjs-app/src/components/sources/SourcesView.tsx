'use client'

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { PauseCircle, Plus, SlidersHorizontal } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { RoleGate } from '@/components/layout/RoleGate'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { DataTable } from '@/components/shared/DataTable'
import { PageHeader } from '@/components/shared/PageHeader'
import { EvalStatusBadge, SourceStatusBadge } from '@/components/sources/SourceBadges'
import { useToast } from '@/components/ui/Toaster'
import { pauseAllSources } from '@/lib/api/safety'
import { fetchSourcesPage } from '@/lib/api/sources'
import { queryKeys } from '@/lib/api/queryKeys'
import type { SourceSummary } from '@/types/sources'

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

const TYPE_LABEL = { hospital: 'Hospital', lab: 'Lab', clinic: 'Clinic' } as const
const SIZE_LABEL = { small: 'Small', medium: 'Medium', large: 'Large' } as const

export function SourcesView() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [pausingAll, setPausingAll] = useState(false)
  const router = useRouter()
  const query = useInfiniteQuery({
    queryKey: queryKeys.sources,
    queryFn: ({ pageParam }) => fetchSourcesPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })
  const sources = useMemo(() => query.data?.pages.flatMap((page) => page.sources) ?? [], [query.data])

  const columns = useMemo<ColumnDef<SourceSummary, unknown>[]>(
    () => [
      {
        id: 'name',
        header: 'Source',
        accessorKey: 'name',
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <Link
              href={`/sources/${row.original.id}`}
              onClick={(event) => event.stopPropagation()}
              className="text-body-lg text-brand hover:underline"
            >
              {row.original.name}
            </Link>
            <span className="text-body-sm text-text-secondary">
              {TYPE_LABEL[row.original.provider_type]} · {SIZE_LABEL[row.original.size_class]}
            </span>
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        accessorKey: 'status',
        cell: ({ row }) => (
          <div className="flex flex-col items-start gap-1">
            <SourceStatusBadge status={row.original.status} />
            {row.original.flagged_poor && <span className="badge-warning">Flagged as poor</span>}
          </div>
        ),
      },
      {
        id: 'eval',
        header: 'Evaluation',
        accessorKey: 'eval_status',
        cell: ({ row }) => <EvalStatusBadge status={row.original.eval_status} basis={row.original.eval_basis} />,
      },
      {
        id: 'queue',
        header: 'Queue depth',
        accessorKey: 'queue_depth',
        cell: ({ row }) => <span className="tabular-nums">{row.original.queue_depth}</span>,
      },
      {
        id: 'created',
        header: 'Created',
        accessorKey: 'created_at',
        cell: ({ row }) => (
          <span className="text-text-secondary">{dateFormatter.format(new Date(row.original.created_at))}</span>
        ),
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sources"
        description="Each hospital, lab or clinic feed. Auto-commit stays off until a source passes its evaluation."
        actions={
          <>
            <Link href="/settings/thresholds" className="btn-secondary">
              <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
              Threshold matrix
            </Link>
            <RoleGate allow={['admin']}>
              <button type="button" className="btn-secondary" onClick={() => setPausingAll(true)}>
                <PauseCircle aria-hidden="true" className="h-4 w-4" />
                Pause all sources
              </button>
            </RoleGate>
            <RoleGate allow={['integration_engineer', 'admin']}>
              <Link href="/sources/new" className="btn-primary">
                <Plus aria-hidden="true" className="h-4 w-4" />
                New source
              </Link>
            </RoleGate>
          </>
        }
      />
      <DataTable
        caption="Provider sources"
        columns={columns}
        data={sources}
        getRowId={(source) => source.id}
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        onRowClick={(source) => router.push(`/sources/${source.id}`)}
        emptyTitle="No sources yet"
        emptyDescription="Create a source to start receiving records from a provider."
        hasMore={query.hasNextPage}
        onLoadMore={() => void query.fetchNextPage()}
        isLoadingMore={query.isFetchingNextPage}
      />
      <ConfirmDialog
        open={pausingAll}
        onOpenChange={setPausingAll}
        title="Pause auto-commit for every source?"
        description="Every new record from every source goes to manual review until each source is resumed. Records already in the queue are not affected."
        confirmLabel="Pause all sources"
        destructive
        requireReason={{ min: 5, label: 'Reason for pausing everything' }}
        onConfirm={async (reason) => {
          const result = await pauseAllSources(reason ?? '')
          await queryClient.invalidateQueries({ queryKey: queryKeys.sources })
          toast({ title: result.paused === 0 ? 'No source had auto-commit on' : `Paused ${result.paused} ${result.paused === 1 ? 'source' : 'sources'}`, tone: 'success' })
        }}
      />
    </div>
  )
}
