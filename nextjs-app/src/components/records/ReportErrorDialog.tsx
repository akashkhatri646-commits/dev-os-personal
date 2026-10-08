'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { Loader2, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { SelectField } from '@/components/ui/fields'
import { useToast } from '@/components/ui/Toaster'
import { ApiError } from '@/lib/api/errors'
import { reportError } from '@/lib/api/safety'
import { RESOURCE_LABELS } from '@/lib/review/labels'
import { SEVERITIES } from '@/lib/validation/safety'
import type { RecordFhirResource } from '@/types/trace'

const SEVERITY_OPTIONS = [
  { value: 'low', label: 'Low: queue a review only' },
  { value: 'medium', label: 'Medium: pause the source' },
  { value: 'high', label: 'High: pause the source and alert' },
  { value: 'critical', label: 'Critical: pause the source and alert' },
]

interface ReportErrorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  recordId: string
  resources: readonly RecordFhirResource[]
  onReported: () => void
}

/** Reports a confirmed problem found downstream in committed data. From medium severity this pauses the source. */
export function ReportErrorDialog({ open, onOpenChange, recordId, resources, onReported }: ReportErrorDialogProps) {
  const { toast } = useToast()
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>('medium')
  const [resourceId, setResourceId] = useState('')
  const [description, setDescription] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (description.trim().length < 10) {
      setError('Describe the problem in at least 10 characters.')
      return
    }
    setPending(true)
    setError(null)
    try {
      const incident = await reportError(recordId, { severity, description: description.trim(), ...(resourceId ? { fhir_resource_id: resourceId } : {}) })
      toast({ title: 'Error reported', description: incident.source_paused ? 'Auto-commit was paused for this source.' : 'A review was queued for the record.', tone: 'success' })
      setDescription('')
      onOpenChange(false)
      onReported()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not report the error. Try again.')
    } finally {
      setPending(false)
    }
  }

  const committed = resources.filter((resource) => resource.committed)
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-text-primary opacity-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border border-border bg-bg-primary p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-h5 text-text-primary">Report a downstream error</Dialog.Title>
              <Dialog.Description className="text-body-sm text-text-secondary">
                Use this when a value committed from this record turned out to be wrong. From medium severity, auto-commit stops for the source until an admin resolves the incident.
              </Dialog.Description>
            </div>
            <Dialog.Close aria-label="Close" className="rounded-md p-1 text-text-secondary hover:bg-bg-subtle">
              <X aria-hidden="true" className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <SelectField label="Severity" options={SEVERITY_OPTIONS} value={severity} onChange={(event) => setSeverity(event.target.value as typeof severity)} />
            {committed.length > 0 && (
              <SelectField
                label="Which value (optional)"
                hint="A reported value is marked as entered in error; it is never deleted."
                options={[{ value: '', label: 'The record as a whole' }, ...committed.map((resource) => ({ value: resource.id, label: `${RESOURCE_LABELS[resource.resource_type] ?? resource.resource_type} ${resource.id.slice(0, 8)}` }))]}
                value={resourceId}
                onChange={(event) => setResourceId(event.target.value)}
              />
            )}
            <div className="flex flex-col gap-1">
              <label htmlFor="error-description" className="text-body-lg text-text-primary">What is wrong?</label>
              <textarea
                id="error-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
                maxLength={1000}
                className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-body-lg text-text-primary focus:border-border-brand"
              />
              <span className="text-body-sm text-text-secondary">Do not include patient names or identifiers.</span>
            </div>
            {error && (
              <p role="alert" className="text-body-sm text-danger-text">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => onOpenChange(false)} disabled={pending}>
                Cancel
              </button>
              <button type="submit" className="btn-danger" disabled={pending}>
                {pending && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
                Report error
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
