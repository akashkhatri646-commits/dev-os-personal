'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { SelectField, TextField } from '@/components/ui/fields'
import { ApiError } from '@/lib/api/errors'
import { patchSource } from '@/lib/api/sources'
import { updateSourceSchema, type UpdateSourceInput } from '@/lib/validation/sources'
import type { SourceDetail } from '@/types/sources'
import { z } from 'zod'

// The shared update schema allows partial updates; this form always submits all of its fields.
const formSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
  size_class: z.enum(['small', 'medium', 'large']),
  region: z.string().trim().max(80),
  primary_language: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{2}$/, 'Use a two-letter ISO 639-1 code, e.g. en'),
  holdback_pct: z.number().min(0, 'Minimum is 0').max(100, 'Maximum is 100'),
})
type FormValues = z.input<typeof formSchema>
type FormOutput = z.output<typeof formSchema>

interface EditSourceDialogProps {
  source: SourceDetail
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

export function EditSourceDialog({ source, open, onOpenChange, onSaved }: EditSourceDialogProps) {
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    values: {
      name: source.name,
      size_class: source.size_class,
      region: source.region ?? '',
      primary_language: source.primary_language,
      holdback_pct: source.holdback_pct,
    },
  })

  function handleOpenChange(next: boolean) {
    if (isSubmitting) return
    if (!next) {
      setFormError(null)
      reset()
    }
    onOpenChange(next)
  }

  async function onSubmit(values: FormOutput) {
    setFormError(null)
    const update: UpdateSourceInput = updateSourceSchema.parse({
      name: values.name,
      size_class: values.size_class,
      region: values.region === '' ? null : values.region,
      primary_language: values.primary_language,
      holdback_pct: values.holdback_pct,
    })
    try {
      await patchSource(source.id, update)
      onSaved()
      onOpenChange(false)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') {
        setError('name', { message: 'A source with this name already exists.' })
        return
      }
      if (error instanceof ApiError && error.code === 'VALIDATION_FAILED') {
        setError('holdback_pct', { message: error.message })
        return
      }
      setFormError(error instanceof ApiError ? error.message : 'Could not save the changes.')
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-text-primary opacity-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-primary p-6">
          <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-h5 text-text-primary">Edit source</Dialog.Title>
              <Dialog.Description className="text-body-sm text-text-secondary">
                Changes are audited. Holdback cannot go below 5% while auto-commit is enabled.
              </Dialog.Description>
            </div>
            <TextField label="Name" autoComplete="off" error={errors.name?.message} {...register('name')} />
            <SelectField
              label="Size"
              options={[
                { value: 'small', label: 'Small' },
                { value: 'medium', label: 'Medium' },
                { value: 'large', label: 'Large' },
              ]}
              error={errors.size_class?.message}
              {...register('size_class')}
            />
            <TextField label="Region" autoComplete="off" error={errors.region?.message} {...register('region')} />
            <TextField
              label="Primary language"
              maxLength={2}
              autoComplete="off"
              error={errors.primary_language?.message}
              {...register('primary_language')}
            />
            <TextField
              label="Audit holdback (%)"
              type="number"
              step="0.5"
              min={0}
              max={100}
              hint="Share of would-be auto-commits also sent to a reviewer to measure the true error rate."
              error={errors.holdback_pct?.message}
              {...register('holdback_pct', { valueAsNumber: true })}
            />
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
                Save changes
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
