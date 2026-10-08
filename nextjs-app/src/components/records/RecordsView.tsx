'use client'

import { useInfiniteQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { DataTable } from '@/components/shared/DataTable'
import { PageHeader } from '@/components/shared/PageHeader'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { SelectField } from '@/components/ui/fields'
import { fetchRecordsPage } from '@/lib/api/ingestions'
import { queryKeys } from '@/lib/api/queryKeys'
import { reasonLabel } from '@/lib/records/reasons'
import type { RecordSummary } from '@/types/records'

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const DOC_LABEL = { discharge_summary: 'Discharge summary', lab_report: 'Lab report', other: 'Other' } as const
const KIND_LABEL = { pdf: 'PDF', image: 'Image', hl7v2: 'HL7v2', text: 'Text' } as const

const STATUS_FILTERS = [
  { value: '', label: 'All records' },
  { value: 'needs_review,in_review', label: 'Needs review' },
  { value: 'auto_committed,committed', label: 'Committed' },
  { value: 'rejected,failed,blocked_consent', label: 'Rejected, failed or blocked' },
  { value: 'received,consent_check,normalizing,extracting,mapping,validating,scoring,routing', label: 'In progress' },
]

export function RecordsView() {
  const router = useRouter()
  const [statusFilter, setStatusFilter] = useState('')
  const filters = useMemo(() => ({ status: statusFilter ? statusFilter.split(',') : [] }), [statusFilter])

  const query = useInfiniteQuery({
    queryKey: queryKeys.recordsList(filters),
    queryFn: ({ pageParam }) => fetchRecordsPage(pageParam, 25, filters),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })
  const records = useMemo(() => query.data?.pages.flatMap((page) => page.records) ?? [], [query.data])

  const columns = useMemo<ColumnDef<RecordSummary, unknown>[]>(
    () => [
      { id: 'received', header: 'Received', accessorKey: 'created_at', cell: ({ row }) => <span className="whitespace-nowrap text-text-secondary">{dateFormatter.format(new Date(row.original.created_at))}</span> },
      {
        id: 'source',
        header: 'Source',
        accessorKey: 'source_name',
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <span className="text-text-primary">{row.original.source_name ?? 'Unknown source'}</span>
            <span className="text-body-sm text-text-secondary">{DOC_LABEL[row.original.doc_type]} · {KIND_LABEL[row.original.input_kind]}</span>
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
        id: 'open',
        header: () => <span className="sr-only">Open</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <Link href={`/records/${row.original.id}`} onClick={(event) => event.stopPropagation()} className="text-body-sm text-brand hover:underline">
            Details
          </Link>
        ),
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Records" description="Every record submitted to the pipeline, with where it stands and why." />
      <div className="w-72">
        <SelectField label="Show" options={STATUS_FILTERS} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} />
      </div>
      <DataTable
        caption="Records"
        columns={columns}
        data={records}
        getRowId={(record) => record.id}
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyTitle="No records match"
        emptyDescription="Submit a record from the Ingest page, or change the filter."
        onRowClick={(record) => router.push(`/records/${record.id}`)}
        hasMore={query.hasNextPage}
        onLoadMore={() => void query.fetchNextPage()}
        isLoadingMore={query.isFetchingNextPage}
      />
    </div>
  )
}
