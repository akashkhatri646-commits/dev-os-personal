'use client'

import { useInfiniteQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useMemo } from 'react'
import { DataTable } from '@/components/shared/DataTable'
import { PageHeader } from '@/components/shared/PageHeader'
import { SourceStatusBadge } from '@/components/sources/SourceBadges'
import { fetchSourcesPage } from '@/lib/api/sources'
import { queryKeys } from '@/lib/api/queryKeys'
import { RESOURCE_KEY_LABEL, THRESHOLD_RESOURCE_KEYS } from '@/lib/sources/rules'
import type { SourceSummary } from '@/types/sources'
import type { ColumnDef } from '@tanstack/react-table'

/** Side-by-side view of active thresholds for every source; editing happens on each source. */
export function ThresholdMatrixView() {
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
        id: 'source',
        header: 'Source',
        accessorKey: 'name',
        cell: ({ row }) => (
          <div className="flex flex-col items-start gap-1">
            <Link
              href={`/sources/${row.original.id}?tab=thresholds`}
              onClick={(event) => event.stopPropagation()}
              className="text-body-lg text-brand hover:underline"
            >
              {row.original.name}
            </Link>
            <SourceStatusBadge status={row.original.status} />
          </div>
        ),
      },
      ...THRESHOLD_RESOURCE_KEYS.map<ColumnDef<SourceSummary, unknown>>((key) => ({
        id: key,
        header: RESOURCE_KEY_LABEL[key],
        accessorFn: (source) => source.thresholds[key] ?? source.thresholds['*'] ?? null,
        cell: ({ row }) => {
          const own = row.original.thresholds[key]
          const value = own ?? row.original.thresholds['*']
          if (value === undefined) return <span className="text-text-secondary">—</span>
          return (
            <span className={own === undefined ? 'tabular-nums text-text-secondary' : 'tabular-nums text-text-primary'}>
              {value.toFixed(3)}
              {own === undefined && <span className="sr-only"> (inherited from default)</span>}
            </span>
          )
        },
      })),
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Threshold matrix"
        description="Active routing thresholds per source and resource type. Greyed values are inherited from the default."
      />
      <DataTable
        caption="Routing thresholds by source and resource type"
        columns={columns}
        data={sources}
        getRowId={(source) => source.id}
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyTitle="No sources yet"
        emptyDescription="Create a source to configure its thresholds."
        emptyAction={
          <Link href="/sources/new" className="btn-primary">
            New source
          </Link>
        }
        hasMore={query.hasNextPage}
        onLoadMore={() => void query.fetchNextPage()}
        isLoadingMore={query.isFetchingNextPage}
      />
    </div>
  )
}
