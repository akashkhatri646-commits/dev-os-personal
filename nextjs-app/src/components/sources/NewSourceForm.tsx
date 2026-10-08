'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { ApiKeyDialog } from '@/components/sources/ApiKeyDialog'
import { PageHeader } from '@/components/shared/PageHeader'
import { SelectField, TextField } from '@/components/ui/fields'
import { ApiError } from '@/lib/api/errors'
import { queryKeys } from '@/lib/api/queryKeys'
import { createSource } from '@/lib/api/sources'
import {
  createSourceSchema,
  type CreateSourceFormInput,
  type CreateSourceInput,
} from '@/lib/validation/sources'
import type { CreatedSource } from '@/types/sources'

const PROVIDER_TYPES = [
  { value: 'hospital', label: 'Hospital' },
  { value: 'lab', label: 'Lab' },
  { value: 'clinic', label: 'Clinic' },
]
const SIZE_CLASSES = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
]

// Only discharge summaries are accepted in the MVP; the server enforces ENABLED_DOC_TYPES.
const DOC_TYPE_OPTIONS = [
  { value: 'discharge_summary', label: 'Discharge summaries', available: true },
  { value: 'lab_report', label: 'Lab reports (available after MVP 1)', available: false },
] as const

export function NewSourceForm() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [created, setCreated] = useState<CreatedSource | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateSourceFormInput, unknown, CreateSourceInput>({
    resolver: zodResolver(createSourceSchema),
    defaultValues: {
      name: '',
      provider_type: 'hospital',
      size_class: 'medium',
      region: '',
      primary_language: 'en',
      doc_types: ['discharge_summary'],
      consent_regime: 'abdm',
    },
  })

  async function onSubmit(values: CreateSourceInput) {
    setFormError(null)
    try {
      const result = await createSource({ ...values, region: values.region || undefined })
      await queryClient.invalidateQueries({ queryKey: queryKeys.sources })
      setCreated(result)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') {
        setError('name', { message: 'A source with this name already exists.' })
        return
      }
      setFormError(error instanceof ApiError ? error.message : 'Could not create the source.')
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageHeader
        title="New source"
        description="Auto-commit starts off. Records from this source go to manual review until it passes its evaluation."
      />

      <form
        onSubmit={handleSubmit(onSubmit)}
        noValidate
        className="flex flex-col gap-4 rounded-lg border border-border bg-bg-primary p-6"
      >
        <TextField label="Name" autoComplete="off" error={errors.name?.message} {...register('name')} />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Provider type"
            options={PROVIDER_TYPES}
            error={errors.provider_type?.message}
            {...register('provider_type')}
          />
          <SelectField
            label="Size"
            options={SIZE_CLASSES}
            error={errors.size_class?.message}
            {...register('size_class')}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Region (optional)"
            autoComplete="off"
            error={errors.region?.message}
            {...register('region')}
          />
          <TextField
            label="Primary language"
            hint="Two-letter code, e.g. en"
            autoComplete="off"
            maxLength={2}
            error={errors.primary_language?.message}
            {...register('primary_language')}
          />
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-body-lg text-text-primary">Document types</legend>
          {DOC_TYPE_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-body-lg text-text-primary">
              <input
                type="checkbox"
                value={option.value}
                disabled={!option.available}
                className="h-4 w-4"
                {...register('doc_types')}
              />
              <span className={option.available ? undefined : 'text-text-disabled'}>{option.label}</span>
            </label>
          ))}
          {errors.doc_types?.message && (
            <span role="alert" className="text-body-sm text-danger-text">
              {errors.doc_types.message}
            </span>
          )}
        </fieldset>

        <p className="text-body-sm text-text-secondary">
          Consent regime: ABDM (the HIPAA path is enabled in a later release).
        </p>

        {formError && (
          <p
            role="alert"
            className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-body-sm text-danger-text"
          >
            {formError}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => router.push('/sources')} disabled={isSubmitting}>
            Cancel
          </button>
          <button type="submit" className="btn-primary disabled:opacity-60" disabled={isSubmitting}>
            {isSubmitting && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
            Create source
          </button>
        </div>
      </form>

      <ApiKeyDialog
        apiKey={created?.api_key ?? null}
        title="Source created"
        onClose={() => {
          const id = created?.id
          setCreated(null)
          if (id) router.push(`/sources/${id}`)
        }}
      />
    </div>
  )
}
