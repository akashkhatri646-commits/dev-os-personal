'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Loader2, X } from 'lucide-react'
import Link from 'next/link'
import { useMemo, useState, type FormEvent } from 'react'
import { DataTable } from '@/components/shared/DataTable'
import { PageHeader } from '@/components/shared/PageHeader'
import { SelectField } from '@/components/ui/fields'
import { useToast } from '@/components/ui/Toaster'
import { ApiError } from '@/lib/api/errors'
import { queryKeys } from '@/lib/api/queryKeys'
import { fetchIncidentsPage, updateIncident } from '@/lib/api/safety'
import { ROOT_CAUSES } from '@/lib/validation/safety'
import type { Incident, IncidentSeverity, IncidentStatus, RootCause } from '@/types/safety'

const dateFormatter = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })

const SEVERITY_BADGE: Record<IncidentSeverity, string> = { low: 'badge-neutral', medium: 'badge-warning', high: 'badge-danger', critical: 'badge-danger' }
const STATUS_BADGE: Record<IncidentStatus, { label: string; className: string }> = {
  open: { label: 'Open', className: 'badge-danger' },
  investigating: { label: 'Investigating', className: 'badge-warning' },
  resolved: { label: 'Resolved', className: 'badge-success' },
}
const ROOT_CAUSE_LABEL: Record<RootCause, string> = {
  extraction: 'Extraction read a value wrongly',
  mapping: 'Mapping picked the wrong code',
  ocr: 'The scan was read wrongly',
  threshold: 'The threshold was too low',
  consent: 'Consent handling',
  other: 'Something else',
}
const FILTERS = [
  { value: '', label: 'All incidents' },
  { value: 'open', label: 'Open' },
  { value: 'investigating', label: 'Investigating' },
  { value: 'resolved', label: 'Resolved' },
]

function CloseDialog({ incident, onOpenChange, onDone }: { incident: Incident | null; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const { toast } = useToast()
  const [status, setStatus] = useState<'investigating' | 'resolved'>('resolved')
  const [rootCause, setRootCause] = useState<RootCause | ''>('')
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!incident) return
    if (status === 'resolved' && !rootCause) {
      setError('Choose a root cause to resolve the incident.')
      return
    }
    setPending(true)
    setError(null)
    try {
      await updateIncident(incident.id, { status, ...(rootCause ? { root_cause: rootCause } : {}), ...(note.trim() ? { note: note.trim() } : {}) })
      toast({ title: status === 'resolved' ? 'Incident resolved' : 'Marked as investigating', tone: 'success' })
      onOpenChange(false)
      onDone()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update the incident.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog.Root open={incident !== null} onOpenChange={(open) => !pending && onOpenChange(open)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-text-primary opacity-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border border-border bg-bg-primary p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-h5 text-text-primary">Update incident</Dialog.Title>
              <Dialog.Description className="text-body-sm text-text-secondary">
                A paused source can only resume once every incident for it is resolved.
              </Dialog.Description>
            </div>
            <Dialog.Close aria-label="Close" className="rounded-md p-1 text-text-secondary hover:bg-bg-subtle">
              <X aria-hidden="true" className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <SelectField
              label="New status"
              options={[{ value: 'investigating', label: 'Investigating' }, { value: 'resolved', label: 'Resolved' }]}
              value={status}
              onChange={(event) => setStatus(event.target.value as typeof status)}
            />
            <SelectField
              label={status === 'resolved' ? 'Root cause' : 'Root cause (optional)'}
              options={[{ value: '', label: 'Choose…' }, ...ROOT_CAUSES.map((cause) => ({ value: cause, label: ROOT_CAUSE_LABEL[cause] }))]}
              value={rootCause}
              onChange={(event) => setRootCause(event.target.value as RootCause | '')}
            />
            <div className="flex flex-col gap-1">
              <label htmlFor="incident-note" className="text-body-lg text-text-primary">Note</label>
              <textarea id="incident-note" value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={1000} className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-body-lg text-text-primary focus:border-border-brand" />
            </div>
            {error && <p role="alert" className="text-body-sm text-danger-text">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={pending}>
                {pending && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
                Save
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function IncidentsView() {
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<IncidentStatus | ''>('')
  const [closing, setClosing] = useState<Incident | null>(null)

  const query = useInfiniteQuery({
    queryKey: queryKeys.incidents(statusFilter),
    queryFn: ({ pageParam }) => fetchIncidentsPage(statusFilter || undefined, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })
  const incidents = useMemo(() => query.data?.pages.flatMap((page) => page.incidents) ?? [], [query.data])

  const columns = useMemo<ColumnDef<Incident, unknown>[]>(
    () => [
      { id: 'reported', header: 'Reported', accessorKey: 'created_at', cell: ({ row }) => <span className="whitespace-nowrap text-body-sm text-text-secondary">{dateFormatter.format(new Date(row.original.created_at))} UTC</span> },
      {
        id: 'source',
        header: 'Source and record',
        accessorKey: 'source_name',
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <Link href={`/sources/${row.original.source_id}`} onClick={(event) => event.stopPropagation()} className="text-brand hover:underline">{row.original.source_name}</Link>
            <Link href={`/records/${row.original.record_id}`} onClick={(event) => event.stopPropagation()} className="font-mono text-body-sm text-text-secondary hover:underline">{row.original.record_id.slice(0, 8)}…</Link>
          </div>
        ),
      },
      {
        id: 'severity',
        header: 'Severity',
        accessorKey: 'severity',
        cell: ({ row }) => (
          <div className="flex flex-col items-start gap-1">
            <span className={SEVERITY_BADGE[row.original.severity]}>{row.original.severity}</span>
            {row.original.source_paused && <span className="text-body-sm text-text-secondary">Source paused</span>}
          </div>
        ),
      },
      {
        id: 'description',
        header: 'What happened',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex max-w-md flex-col gap-0.5">
            <span className="text-body-sm text-text-primary">{row.original.description}</span>
            <span className="text-body-sm text-text-secondary">Reported by {row.original.reported_by_name ?? 'a user'}</span>
            {row.original.root_cause && <span className="text-body-sm text-text-secondary">Root cause: {ROOT_CAUSE_LABEL[row.original.root_cause]}</span>}
          </div>
        ),
      },
      { id: 'status', header: 'Status', accessorKey: 'status', cell: ({ row }) => <span className={STATUS_BADGE[row.original.status].className}>{STATUS_BADGE[row.original.status].label}</span> },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.status === 'resolved' ? null : (
            <button type="button" className="btn-secondary px-3 py-1" onClick={(event) => { event.stopPropagation(); setClosing(row.original) }}>
              Update
            </button>
          ),
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Incidents" description="Confirmed downstream errors in data this system committed. A paused source stays paused until its incidents are resolved." />
      <div className="w-60">
        <SelectField label="Show" options={FILTERS} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as IncidentStatus | '')} />
      </div>
      <DataTable
        caption="Downstream error incidents"
        columns={columns}
        data={incidents}
        getRowId={(incident) => incident.id}
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyTitle="No incidents"
        emptyDescription="Reported downstream errors appear here."
        hasMore={query.hasNextPage}
        onLoadMore={() => void query.fetchNextPage()}
        isLoadingMore={query.isFetchingNextPage}
      />
      <CloseDialog
        key={closing?.id ?? 'none'}
        incident={closing}
        onOpenChange={(open) => !open && setClosing(null)}
        onDone={() => void queryClient.invalidateQueries({ queryKey: ['incidents'] })}
      />
    </div>
  )
}
