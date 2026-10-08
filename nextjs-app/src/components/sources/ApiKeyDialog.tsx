'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import { CopyField } from '@/components/shared/CopyField'

interface ApiKeyDialogProps {
  /** Plaintext key to display; the dialog is closed when null. */
  apiKey: string | null
  title: string
  onClose: () => void
}

/**
 * Shows an API key exactly once. It cannot be dismissed (Escape, outside click) until the user
 * confirms they stored it, because the plaintext is never retrievable again.
 */
export function ApiKeyDialog({ apiKey, title, onClose }: ApiKeyDialogProps) {
  const [acknowledged, setAcknowledged] = useState(false)

  function close() {
    setAcknowledged(false)
    onClose()
  }

  return (
    <Dialog.Root open={apiKey !== null} onOpenChange={(open) => !open && acknowledged && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-text-primary opacity-40" />
        <Dialog.Content
          onEscapeKeyDown={(event) => !acknowledged && event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-primary p-6"
        >
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-h5 text-text-primary">{title}</Dialog.Title>
              <Dialog.Description className="text-body-sm text-text-secondary">
                This key is shown only once. Store it in your integration&apos;s secret manager; only a hash is
                kept here, so it cannot be shown again.
              </Dialog.Description>
            </div>
            {apiKey && <CopyField label="API key" value={apiKey} />}
            <label className="flex items-start gap-2 text-body-lg text-text-primary">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-1 h-4 w-4"
              />
              I have stored this key
            </label>
            <div className="flex justify-end">
              <button type="button" className="btn-primary disabled:opacity-60" disabled={!acknowledged} onClick={close}>
                Done
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
