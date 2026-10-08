'use client'

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { AddConsentDialog } from '@/components/consent/AddConsentDialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { DataTable } from '@/components/shared/DataTable'
import { PageHeader } from '@/components/shared/PageHeader'
import { useToast } from '@/components/ui/Toaster'
import { fetchConsentPage, setConsentStatus } from '@/lib/api/consent'
import { queryKeys } from '@/lib/api/queryKeys'
import type { ConsentArtifactView, EffectiveConsentStatus } from '@/types/consent'

const STATUS: Record<EffectiveConsentStatus, { label: string; className: string }> = {
  valid: { label: 'Valid', className: 'badge-success' },
  expired: { label: 'Expired', className: 'badge-warning' },
  revoked: { label: 'Revoked', className: 'badge-danger' },
  not_yet_valid: { label: 'Not yet valid', className: 'badge-info' },
}

const dateFormatter = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })

export function ConsentAdminView() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [addOpen, setAddOpen] = useState(false)
  const [pending, setPending] = useState<ConsentArtifactView | null>(null)

  const query = useInfiniteQuery({
    queryKey: queryKeys.consentArtifacts,
    queryFn: ({ pageParam }) => fetchConsentPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })
  const artifacts = useMemo(() => query.data?.pages.flatMap((page) => page.artifacts) ?? [], [query.data])

  const columns = useMemo<ColumnDef<ConsentArtifactView, unknown>[]>(
    () => [
      {
        id: 'patient',
        header: 'Patient',
        accessorKey: 'patient_label',
        cell: ({ row }) => <span className="whitespace-nowrap text-text-primary">{row.original.patient_label}</span>,
      },
      {
        id: 'reference',
        header: 'Reference',
        accessorKey: 'artifact_ref',
        cell: ({ row }) => <span className="font-mono text-body-sm">{row.original.artifact_ref}</span>,
      },
      {
        id: 'categories',
        header: 'Covers',
        accessorFn: (row) => row.categories.join(', '),
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.categories.map((category) => (
              <span key={category} className="badge-neutral">
                {category}
              </span>
            ))}
          </div>
        ),
      },
      {
        id: 'window',
        header: 'Valid (UTC)',
        accessorKey: 'valid_from',
        cell: ({ row }) => (
          <span className="text-body-sm text-text-secondary">
            {dateFormatter.format(new Date(row.original.valid_from))}
            <br />
            to {dateFormatter.format(new Date(row.original.valid_to))}
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        accessorKey: 'effective_status',
        cell: ({ row }) => {
          const { label, className } = STATUS[row.original.effective_status]
          return <span className={className}>{label}</span>
        },
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <button
            type="button"
            className="btn-secondary px-3 py-1"
            onClick={(event) => {
              event.stopPropagation()
              setPending(row.original)
            }}
          >
            {row.original.status === 'revoked' ? 'Grant again' : 'Revoke'}
          </button>
        ),
      },
    ],
    [],
  )

  const revoking = pending !== null && pending.status !== 'revoked'

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Consent ledger (stub)"
        description="Test data for the built-in consent ledger. The pipeline blocks any record whose patient has no valid consent covering every requested category. Available only while CONSENT_MODE is stub."
        actions={
          <button type="button" className="btn-primary" onClick={() => setAddOpen(true)}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add consent
          </button>
        }
      />

      <DataTable
        caption="Consent artifacts in the stub ledger"
        columns={columns}
        data={artifacts}
        getRowId={(artifact) => artifact.id}
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyTitle="No consent artifacts yet"
        emptyDescription="Add one for a patient to let their records through the consent check."
        hasMore={query.hasNextPage}
        onLoadMore={() => void query.fetchNextPage()}
        isLoadingMore={query.isFetchingNextPage}
      />

      <AddConsentDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={() => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.consentArtifacts })
          toast({ title: 'Consent added', tone: 'success' })
        }}
      />

      {pending && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setPending(null)
          }}
          title={revoking ? 'Revoke this consent?' : 'Grant this consent again?'}
          description={
            revoking
              ? 'New records for this patient will be blocked from the next check. Records already processed are not affected.'
              : 'The consent becomes active again if it is still within its dates.'
          }
          confirmLabel={revoking ? 'Revoke' : 'Grant again'}
          destructive={revoking}
          onConfirm={async () => {
            await setConsentStatus(pending.id, revoking ? 'revoked' : 'granted')
            await queryClient.invalidateQueries({ queryKey: queryKeys.consentArtifacts })
            toast({ title: revoking ? 'Consent revoked' : 'Consent granted again', tone: 'success' })
          }}
        />
      )}
    </div>
  )
}
