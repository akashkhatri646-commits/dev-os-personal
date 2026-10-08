'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { CheckCircle2, TriangleAlert, X } from 'lucide-react'
import Link from 'next/link'
import { formatAuditTime } from '@/components/audit/format'
import type { AuditRow } from '@/types/auditApi'

interface AuditDetailDialogProps {
  row: AuditRow | null
  onOpenChange: (open: boolean) => void
  /** Opens the reconstruction of the entry's record. */
  onReconstruct: (recordId: string) => void
}

export function AuditDetailDialog({ row, onOpenChange, onReconstruct }: AuditDetailDialogProps) {
  return (
    <Dialog.Root open={row !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-text-primary opacity-40" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col gap-4 overflow-y-auto border-l border-border bg-bg-primary p-6">
          {row && (
            <>
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <Dialog.Title className="font-mono text-h5 text-text-primary">{row.event}</Dialog.Title>
                  <Dialog.Description className="text-body-sm text-text-secondary">
                    Entry #{row.id} · {formatAuditTime(row.created_at)}
                  </Dialog.Description>
                </div>
                <Dialog.Close aria-label="Close" className="rounded-md p-1 text-text-secondary hover:bg-bg-subtle">
                  <X aria-hidden="true" className="h-4 w-4" />
                </Dialog.Close>
              </div>

              <dl className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-0.5">
                  <dt className="text-body-lg text-text-primary">Actor</dt>
                  <dd className="break-all text-body-sm text-text-secondary">
                    {row.actor_name ?? (row.actor_type === 'system' ? 'System' : row.actor_id ?? 'Unknown')}
                    <span className="block text-text-disabled">{row.actor_type}</span>
                  </dd>
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="text-body-lg text-text-primary">Record</dt>
                  <dd className="break-all text-body-sm text-text-secondary">
                    {row.record_id ? (
                      <Link href={`/records/${row.record_id}`} className="text-brand hover:underline">
                        {row.record_id}
                      </Link>
                    ) : (
                      'None (not tied to a record)'
                    )}
                  </dd>
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="text-body-lg text-text-primary">Integrity</dt>
                  <dd
                    className={
                      row.hash_ok
                        ? 'inline-flex items-center gap-1 text-body-sm text-success-text'
                        : 'inline-flex items-center gap-1 text-body-sm text-danger-text'
                    }
                  >
                    {row.hash_ok ? (
                      <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
                    ) : (
                      <TriangleAlert aria-hidden="true" className="h-4 w-4" />
                    )}
                    {row.hash_ok ? 'Hash and chain link verified' : 'Verification failed'}
                  </dd>
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="text-body-lg text-text-primary">Hash</dt>
                  <dd className="font-mono text-body-sm text-text-secondary">{row.hash_short}…</dd>
                </div>
              </dl>

              {row.record_id && (
                <button type="button" className="btn-secondary w-fit" onClick={() => onReconstruct(row.record_id as string)}>
                  Reconstruct this record
                </button>
              )}

              <div className="flex flex-col gap-1">
                <h3 className="text-body-lg text-text-primary">Payload</h3>
                <pre className="max-h-96 overflow-auto rounded-md border border-border bg-bg-surface p-3 font-mono text-body-sm text-text-primary">
                  {JSON.stringify(row.payload, null, 2)}
                </pre>
                <p className="text-body-sm text-text-secondary">
                  Payloads hold identifiers and reason codes only, never patient data.
                </p>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
