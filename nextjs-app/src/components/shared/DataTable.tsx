'use client'

import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, Loader2 } from 'lucide-react'
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { ErrorState } from '@/components/shared/ErrorState'
import { cn } from '@/lib/utils/cn'

interface DataTableProps<T> {
  columns: ColumnDef<T, unknown>[]
  data: T[]
  /** Accessible table name (rendered as a visually hidden caption). */
  caption: string
  getRowId: (row: T) => string
  isLoading?: boolean
  error?: unknown
  onRetry?: () => void
  emptyTitle?: string
  emptyDescription?: string
  emptyAction?: ReactNode
  onRowClick?: (row: T) => void
  /** Cursor pagination: show "Load more" while the server reports another page. */
  hasMore?: boolean
  onLoadMore?: () => void
  isLoadingMore?: boolean
  skeletonRows?: number
}

/**
 * Table wrapper with sorting of the loaded rows, cursor pagination, keyboard row navigation
 * (Up/Down move focus, Enter activates) and the standard loading/empty/error states.
 */
export function DataTable<T>({
  columns,
  data,
  caption,
  getRowId,
  isLoading = false,
  error,
  onRetry,
  emptyTitle = 'Nothing to show yet',
  emptyDescription,
  emptyAction,
  onRowClick,
  hasMore = false,
  onLoadMore,
  isLoadingMore = false,
  skeletonRows = 5,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([])
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => getRowId(row),
  })

  if (error) return <ErrorState error={error} onRetry={onRetry} />
  if (!isLoading && data.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: T) {
    if (event.key === 'Enter' && onRowClick) {
      event.preventDefault()
      onRowClick(row)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const sibling =
      event.key === 'ArrowDown'
        ? event.currentTarget.nextElementSibling
        : event.currentTarget.previousElementSibling
    if (sibling instanceof HTMLElement) sibling.focus()
  }

  const headerGroups = table.getHeaderGroups()
  const columnCount = columns.length

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-lg border border-border bg-bg-primary">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">{caption}</caption>
          <thead className="border-b border-border bg-bg-surface">
            {headerGroups.map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted()
                  const canSort = header.column.getCanSort()
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={
                        sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'
                      }
                      className="whitespace-nowrap px-4 py-3 text-body-sm font-medium text-text-secondary"
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="inline-flex items-center gap-1 rounded-sm hover:text-text-primary"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sorted === 'asc' && <ArrowUp aria-hidden="true" className="h-3 w-3" />}
                          {sorted === 'desc' && <ArrowDown aria-hidden="true" className="h-3 w-3" />}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody aria-busy={isLoading}>
            {isLoading
              ? Array.from({ length: skeletonRows }, (_, rowIndex) => (
                  <tr key={rowIndex} className="border-b border-border last:border-b-0">
                    {Array.from({ length: columnCount }, (_, cellIndex) => (
                      <td key={cellIndex} className="px-4 py-3">
                        <Skeleton className="h-4 w-full" />
                      </td>
                    ))}
                  </tr>
                ))
              : table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    onKeyDown={(event) => handleRowKeyDown(event, row.original)}
                    className={cn(
                      'border-b border-border last:border-b-0 transition-colors duration-fast ease-out hover:bg-bg-subtle',
                      onRowClick && 'cursor-pointer',
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-4 py-3 align-middle text-body-sm text-text-primary">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>

      {hasMore && onLoadMore && (
        <div className="flex justify-center">
          <button type="button" onClick={onLoadMore} disabled={isLoadingMore} className="btn-secondary">
            {isLoadingMore && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
            Load more
          </button>
        </div>
      )}
    </div>
  )
}
