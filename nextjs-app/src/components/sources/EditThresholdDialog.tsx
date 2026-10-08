'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import type { z } from 'zod'
import { TextField } from '@/components/ui/fields'
import { ApiError } from '@/lib/api/errors'
import { putThreshold } from '@/lib/api/sources'
import {
  RESOURCE_KEY_LABEL,
  THRESHOLD_MAX,
  thresholdFloor,
  type ThresholdResourceKey,
} from '@/lib/sources/rules'
import { setThresholdSchema, type SetThresholdInput } from '@/lib/validation/sources'

interface EditThresholdDialogProps {
  sourceId: string
  /** Resource key being edited; the dialog is closed when null. */
  resourceKey: ThresholdResourceKey | null
  currentValue: number | null
  onOpenChange: (open: boolean) => void
  onSaved: (resourceKey: ThresholdResourceKey) => void
}

type FormValues = z.input<typeof setThresholdSchema>

export function EditThresholdDialog({
  sourceId,
  resourceKey,
  currentValue,
  onOpenChange,
  onSaved,
}: EditThresholdDialogProps) {
  const [formError, setFormError] = useState<string | null>(null)
  const floor = resourceKey ? thresholdFloor(resourceKey) : 0.5
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, SetThresholdInput>({
    resolver: zodResolver(setThresholdSchema),
    values: {
      resource_type: resourceKey ?? '*',
      threshold: currentValue ?? 0.97,
      reason: '',
    },
  })

  function handleOpenChange(open: boolean) {
    if (isSubmitting) return
    if (!open) {
      setFormError(null)
      reset()
    }
    onOpenChange(open)
  }

  async function onSubmit(values: SetThresholdInput) {
    if (!resourceKey) return
    setFormError(null)
    try {
      await putThreshold(sourceId, values)
      onSaved(resourceKey)
      onOpenChange(false)
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : 'Could not change the threshold.')
    }
  }

  return (
    <Dialog.Root open={resourceKey !== null} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-text-primary opacity-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-primary p-6">
          <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-h5 text-text-primary">
                Change threshold{resourceKey ? `: ${RESOURCE_KEY_LABEL[resourceKey]}` : ''}
              </Dialog.Title>
              <Dialog.Description className="text-body-sm text-text-secondary">
                Records score at or above this value can auto-commit. A new version is created and the change is
                audited; past routing decisions keep the version they used.
              </Dialog.Description>
            </div>

            <input type="hidden" {...register('resource_type')} />
            <TextField
              label="Threshold"
              type="number"
              step="0.001"
              min={floor}
              max={THRESHOLD_MAX}
              inputMode="decimal"
              hint={`Between ${floor} and ${THRESHOLD_MAX}${floor > 0.5 ? ' (safety floor for this resource type)' : ''}`}
              error={errors.threshold?.message}
              {...register('threshold', { valueAsNumber: true })}
            />
            <div className="flex flex-col gap-1">
              <label htmlFor="threshold-reason" className="text-body-lg text-text-primary">
                Reason
              </label>
              <textarea
                id="threshold-reason"
                rows={3}
                aria-invalid={errors.reason ? true : undefined}
                aria-describedby={errors.reason ? 'threshold-reason-error' : undefined}
                className="rounded-md border border-border bg-bg-primary px-3 py-2 text-body-lg text-text-primary focus:border-border-brand"
                {...register('reason')}
              />
              {errors.reason && (
                <span id="threshold-reason-error" role="alert" className="text-body-sm text-danger-text">
                  {errors.reason.message}
                </span>
              )}
            </div>

            {formError && (
              <p
                role="alert"
                className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-body-sm text-danger-text"
              >
                {formError}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <button type="button" className="btn-secondary" disabled={isSubmitting}>
                  Cancel
                </button>
              </Dialog.Close>
              <button type="submit" className="btn-primary disabled:opacity-60" disabled={isSubmitting}>
                {isSubmitting && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
                Save new version
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
