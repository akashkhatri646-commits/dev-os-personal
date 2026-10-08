'use client'

import { useInfiniteQuery, useMutation } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { CheckCircle2, Download, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { AuditDetailDialog } from '@/components/audit/AuditDetailDialog'
import { AuditTimeline } from '@/components/audit/AuditTimeline'
import { AuditFilterBar } from '@/components/audit/AuditFilterBar'
import { ExportDialog } from '@/components/audit/ExportDialog'
import { formatAuditTime } from '@/components/audit/format'
import { DataTable } from '@/components/shared/DataTable'
import { PageHeader } from '@/components/shared/PageHeader'
import { fetchAuditPage, verifyAuditChain } from '@/lib/api/audit'
import { ApiError } from '@/lib/api/errors'
import { queryKeys } from '@/lib/api/queryKeys'
import type { AuditFilters } from '@/lib/validation/audit'
import type { AuditRow } from '@/types/auditApi'

export function AuditView() {
  const [filters, setFilters] = useState<AuditFilters>({})
  const [selected, setSelected] = useState<AuditRow | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [reconstructId, setReconstructId] = useState<string | null>(null)

  const query = useInfiniteQuery({
    queryKey: queryKeys.audit(filters),
    queryFn: ({ pageParam }) => fetchAuditPage(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })
  const rows = useMemo(() => query.data?.pages.flatMap((page) => page.rows) ?? [], [query.data])
  const tamperedRow = rows.find((row) => !row.hash_ok)

  const verify = useMutation({ mutationFn: verifyAuditChain })

  const columns = useMemo<ColumnDef<AuditRow, unknown>[]>(
    () => [
      {
        id: 'time',
        header: 'Time',
        accessorKey: 'created_at',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-text-secondary">{formatAuditTime(row.original.created_at)}</span>
        ),
      },
      {
        id: 'event',
        header: 'Event',
        accessorKey: 'event',
        cell: ({ row }) => <span className="font-mono text-body-sm text-text-primary">{row.original.event}</span>,
      },
      {
        id: 'actor',
        header: 'Actor',
        accessorFn: (row) => row.actor_name ?? row.actor_type,
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <span className="text-text-primary">
              {row.original.actor_name ?? (row.original.actor_type === 'system' ? 'System' : 'Unknown user')}
            </span>
            <span className="text-body-sm text-text-secondary">{row.original.actor_type}</span>
          </div>
        ),
      },
      {
        id: 'record',
        header: 'Record',
        accessorKey: 'record_id',
        cell: ({ row }) =>
          row.original.record_id ? (
            <Link
              href={`/records/${row.original.record_id}`}
              onClick={(event) => event.stopPropagation()}
              className="font-mono text-body-sm text-brand hover:underline"
            >
              {row.original.record_id.slice(0, 8)}…
            </Link>
          ) : (
            <span className="text-text-disabled">—</span>
          ),
      },
      {
        id: 'integrity',
        header: 'Integrity',
        accessorKey: 'hash_ok',
        cell: ({ row }) =>
          row.original.hash_ok ? (
            <span className="inline-flex items-center gap-1 text-success-text">
              <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
              Verified
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-danger-text">
              <TriangleAlert aria-hidden="true" className="h-4 w-4" />
              Failed
            </span>
          ),
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit log"
        description="Immutable, hash-chained record of every decision and administrative action. Times are in UTC."
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={() => verify.mutate()} disabled={verify.isPending}>
              {verify.isPending ? (
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck aria-hidden="true" className="h-4 w-4" />
              )}
              Verify integrity
            </button>
            <button type="button" className="btn-secondary" onClick={() => setExportOpen(true)}>
              <Download aria-hidden="true" className="h-4 w-4" />
              Export
            </button>
          </>
        }
      />

      {tamperedRow && (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-body-sm text-danger-text">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          Audit integrity check failed at entry #{tamperedRow.id}. Contact your security team before relying on this log.
        </p>
      )}

      {verify.isSuccess && (
        <p
          role="status"
          className={
            verify.data.ok
              ? 'flex items-center gap-2 rounded-md border border-success-border bg-success-bg px-3 py-2 text-body-sm text-success-text'
              : 'flex items-center gap-2 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-body-sm text-danger-text'
          }
        >
          {verify.data.ok ? (
            <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0" />
          ) : (
            <TriangleAlert aria-hidden="true" className="h-4 w-4 shrink-0" />
          )}
          {verify.data.ok
            ? 'The full audit chain verified: no entry has been altered or removed.'
            : `The chain breaks at entry #${verify.data.first_broken_id}. Contact your security team.`}
        </p>
      )}
      {verify.isError && (
        <p role="alert" className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-body-sm text-danger-text">
          {verify.error instanceof ApiError ? verify.error.message : 'Could not verify the audit chain.'}
        </p>
      )}

      <AuditFilterBar onApply={setFilters} />

      <DataTable
        caption="Audit entries, newest first"
        columns={columns}
        data={rows}
        getRowId={(row) => String(row.id)}
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        onRowClick={setSelected}
        emptyTitle="No audit entries match these filters"
        emptyDescription="Adjust the filters or widen the date range."
        hasMore={query.hasNextPage}
        onLoadMore={() => void query.fetchNextPage()}
        isLoadingMore={query.isFetchingNextPage}
        skeletonRows={8}
      />

      <AuditDetailDialog
        row={selected}
        onOpenChange={(open) => !open && setSelected(null)}
        onReconstruct={(recordId) => {
          setSelected(null)
          setReconstructId(recordId)
        }}
      />
      <AuditTimeline recordId={reconstructId} onOpenChange={(open) => !open && setReconstructId(null)} />
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} filters={filters} />
    </div>
  )
}
