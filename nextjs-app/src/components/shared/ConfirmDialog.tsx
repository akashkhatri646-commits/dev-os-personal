'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { Loader2 } from 'lucide-react'
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError } from '@/lib/api/errors'
import { cn } from '@/lib/utils/cn'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  destructive?: boolean
  /** When set, the user must type a reason of at least `min` characters (safety actions, spec 11 §6). */
  requireReason?: { min: number; label?: string }
  /** Extra form controls rendered above the reason field (e.g. an export format). */
  extra?: ReactNode
  /** Runs on confirm; reject/throw to keep the dialog open and show the error. */
  onConfirm: (reason?: string) => Promise<void> | void
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive = false,
  requireReason,
  extra,
  onConfirm,
}: ConfirmDialogProps) {
  const reasonId = useId()
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmedReason = reason.trim()
  const reasonValid = !requireReason || trimmedReason.length >= requireReason.min

  function handleOpenChange(next: boolean) {
    if (pending) return
    if (!next) {
      setReason('')
      setError(null)
    }
    onOpenChange(next)
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!reasonValid || pending) return
    setPending(true)
    setError(null)
    try {
      await onConfirm(requireReason ? trimmedReason : undefined)
      setReason('')
      onOpenChange(false)
    } catch (caught) {
      setError(caught instanceof ApiError || caught instanceof Error ? caught.message : 'Action failed.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-text-primary opacity-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-primary p-6">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-h5 text-text-primary">{title}</Dialog.Title>
              <Dialog.Description className="text-body-sm text-text-secondary">
                {description}
              </Dialog.Description>
            </div>

            {extra}

            {requireReason && (
              <div className="flex flex-col gap-1">
                <label htmlFor={reasonId} className="text-body-lg text-text-primary">
                  {requireReason.label ?? 'Reason'}
                </label>
                <textarea
                  id={reasonId}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={3}
                  className="rounded-md border border-border bg-bg-primary px-3 py-2 text-body-lg text-text-primary focus:border-border-brand"
                  aria-describedby={`${reasonId}-hint`}
                />
                <span id={`${reasonId}-hint`} className="text-body-sm text-text-secondary">
                  At least {requireReason.min} characters. Recorded in the audit log.
                </span>
              </div>
            )}

            {error && (
              <p role="alert" className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-body-sm text-danger-text">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <button type="button" className="btn-secondary" disabled={pending}>
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                disabled={!reasonValid || pending}
                className={cn(destructive ? 'btn-danger' : 'btn-primary', 'disabled:opacity-60')}
              >
                {pending && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
                {confirmLabel}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
