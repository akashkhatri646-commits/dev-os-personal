'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { Skeleton } from '@/components/ui/Skeleton'
import { ErrorState } from '@/components/shared/ErrorState'
import { fetchThresholdHistory } from '@/lib/api/sources'
import { queryKeys } from '@/lib/api/queryKeys'

interface ThresholdHistoryDialogProps {
  sourceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function ThresholdHistoryDialog({ sourceId, open, onOpenChange }: ThresholdHistoryDialogProps) {
  const query = useQuery({
    queryKey: queryKeys.thresholdHistory(sourceId),
    queryFn: () => fetchThresholdHistory(sourceId),
    enabled: open,
  })

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-text-primary opacity-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[calc(100vw-32px)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border border-border bg-bg-primary p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-h5 text-text-primary">Threshold history</Dialog.Title>
              <Dialog.Description className="text-body-sm text-text-secondary">
                Every version ever set for this source, newest first.
              </Dialog.Description>
            </div>
            <Dialog.Close aria-label="Close" className="rounded-md p-1 text-text-secondary hover:bg-bg-subtle">
              <X aria-hidden="true" className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="min-h-0 overflow-auto">
            {query.isPending ? (
              <div className="flex flex-col gap-2" aria-busy="true">
                {Array.from({ length: 4 }, (_, index) => (
                  <Skeleton key={index} className="h-8 w-full" />
                ))}
              </div>
            ) : query.error ? (
              <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : query.data.length === 0 ? (
              <p className="text-body-sm text-text-secondary">No history yet.</p>
            ) : (
              <table className="w-full border-collapse text-left">
                <caption className="sr-only">Threshold versions</caption>
                <thead className="border-b border-border">
                  <tr>
                    {['When', 'Resource', 'Version', 'Value', 'Reason'].map((heading) => (
                      <th key={heading} scope="col" className="px-2 py-2 text-body-sm font-medium text-text-secondary">
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {query.data.map((row) => (
                    <tr key={`${row.resource_type}-${row.version}`} className="border-b border-border last:border-b-0">
                      <td className="px-2 py-2 text-body-sm text-text-secondary">
                        {dateFormatter.format(new Date(row.created_at))}
                      </td>
                      <td className="px-2 py-2 text-body-sm text-text-primary">
                        {row.resource_type === '*' ? 'Default' : row.resource_type}
                      </td>
                      <td className="px-2 py-2 text-body-sm tabular-nums text-text-primary">
                        v{row.version}
                        {row.active && <span className="badge-success ml-2">Active</span>}
                      </td>
                      <td className="px-2 py-2 text-body-sm tabular-nums text-text-primary">
                        {row.threshold.toFixed(3)}
                      </td>
                      <td className="px-2 py-2 text-body-sm text-text-primary">{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
