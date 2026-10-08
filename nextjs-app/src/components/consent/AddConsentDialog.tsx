'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { SelectField, TextField } from '@/components/ui/fields'
import { ApiError } from '@/lib/api/errors'
import { createConsentArtifact } from '@/lib/api/consent'
import { queryKeys } from '@/lib/api/queryKeys'
import { fetchSourcesPage } from '@/lib/api/sources'
import { createConsentArtifactSchema } from '@/lib/validation/consent'
import { DATA_CATEGORIES, type DataCategory } from '@/lib/validation/ingestion'
import type { PatientIdentifierType } from '@/lib/validation/patientIdentifier'

interface AddConsentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}

/** `datetime-local` value for a Date in the browser's time zone. */
function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function toIso(local: string): string | undefined {
  const date = new Date(local)
  return local && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined
}

const DAY_MS = 24 * 60 * 60 * 1000

interface Scenario {
  label: string
  description: string
  build: (now: Date) => { from: Date; to: Date; status: 'granted' | 'revoked' }
}

/** Ready-made cases for exercising the consent gate end to end. */
const SCENARIOS: readonly Scenario[] = [
  {
    label: 'Valid (30 days)',
    description: 'Active now, ends in 30 days',
    build: (now) => ({ from: new Date(now.getTime() - DAY_MS), to: new Date(now.getTime() + 30 * DAY_MS), status: 'granted' }),
  },
  {
    label: 'Expired',
    description: 'Ended yesterday',
    build: (now) => ({ from: new Date(now.getTime() - 30 * DAY_MS), to: new Date(now.getTime() - DAY_MS), status: 'granted' }),
  },
  {
    label: 'Starts tomorrow',
    description: 'Not yet in force',
    build: (now) => ({ from: new Date(now.getTime() + DAY_MS), to: new Date(now.getTime() + 30 * DAY_MS), status: 'granted' }),
  },
  {
    label: 'Revoked',
    description: 'In date but revoked',
    build: (now) => ({ from: new Date(now.getTime() - DAY_MS), to: new Date(now.getTime() + 30 * DAY_MS), status: 'revoked' }),
  },
]

export function AddConsentDialog({ open, onOpenChange, onCreated }: AddConsentDialogProps) {
  const sources = useQuery({
    queryKey: queryKeys.sourceOptions,
    queryFn: () => fetchSourcesPage(undefined, 100),
    enabled: open,
    staleTime: 60_000,
  })

  const [sourceId, setSourceId] = useState('')
  const [identifierType, setIdentifierType] = useState<PatientIdentifierType>('abha')
  const [identifierValue, setIdentifierValue] = useState('')
  const [artifactRef, setArtifactRef] = useState('')
  const [categories, setCategories] = useState<DataCategory[]>(['DischargeSummary'])
  const [validFrom, setValidFrom] = useState('')
  const [validTo, setValidTo] = useState('')
  const [status, setStatus] = useState<'granted' | 'revoked'>('granted')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const sourceOptions = (sources.data?.sources ?? []).map((source) => ({ value: source.id, label: source.name }))
  const effectiveSourceId = sourceId || sourceOptions[0]?.value || ''

  function applyScenario(scenario: Scenario) {
    const { from, to, status: nextStatus } = scenario.build(new Date())
    setValidFrom(toLocalInput(from))
    setValidTo(toLocalInput(to))
    setStatus(nextStatus)
  }

  function reset() {
    setIdentifierValue('')
    setArtifactRef('')
    setCategories(['DischargeSummary'])
    setValidFrom('')
    setValidTo('')
    setStatus('granted')
    setErrors({})
    setFormError(null)
  }

  function handleOpenChange(next: boolean) {
    if (submitting) return
    if (!next) reset()
    onOpenChange(next)
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setFormError(null)
    const parsed = createConsentArtifactSchema.safeParse({
      source_id: effectiveSourceId,
      patient_identifier: { type: identifierType, value: identifierValue.trim() },
      artifact_ref: artifactRef,
      categories,
      valid_from: toIso(validFrom),
      valid_to: toIso(validTo),
      status,
    })
    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] === 'patient_identifier' ? 'identifier' : String(issue.path[0])
        const missingDate = (key === 'valid_from' || key === 'valid_to') && issue.code === 'invalid_type'
        next[key] ??= missingDate ? 'Choose a date and time' : issue.path[0] === 'source_id' ? 'Choose a source' : issue.message
      }
      setErrors(next)
      return
    }
    setErrors({})
    setSubmitting(true)
    try {
      await createConsentArtifact(parsed.data)
      onCreated()
      reset()
      onOpenChange(false)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') {
        setErrors({ artifact_ref: 'A consent with this reference already exists.' })
      } else {
        setFormError(error instanceof ApiError ? error.message : 'Could not add the consent.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-text-primary opacity-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100vw-32px)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto rounded-xl border border-border bg-bg-primary p-6">
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-h5 text-text-primary">Add consent</Dialog.Title>
              <Dialog.Description className="text-body-sm text-text-secondary">
                Test tool for the stub ledger. Pick a scenario to fill the dates, or set them yourself.
              </Dialog.Description>
            </div>

            <SelectField
              label="Source"
              options={sourceOptions.length > 0 ? sourceOptions : [{ value: '', label: 'No sources available' }]}
              value={effectiveSourceId}
              onChange={(event) => setSourceId(event.target.value)}
              error={errors.source_id}
            />
            <div className="grid grid-cols-[7rem_1fr] gap-2">
              <SelectField
                label="Patient ID"
                options={[
                  { value: 'abha', label: 'ABHA' },
                  { value: 'mrn', label: 'MRN' },
                ]}
                value={identifierType}
                onChange={(event) => setIdentifierType(event.target.value === 'mrn' ? 'mrn' : 'abha')}
              />
              <TextField
                label="Identifier"
                autoComplete="off"
                value={identifierValue}
                onChange={(event) => setIdentifierValue(event.target.value)}
                error={errors.identifier}
              />
            </div>
            <TextField
              label="Consent reference"
              autoComplete="off"
              hint="A unique id for this consent, e.g. consent-001"
              value={artifactRef}
              onChange={(event) => setArtifactRef(event.target.value)}
              error={errors.artifact_ref}
            />

            <fieldset className="flex flex-col gap-2">
              <legend className="text-body-lg text-text-primary">Categories covered</legend>
              <div className="grid gap-1 sm:grid-cols-2">
                {DATA_CATEGORIES.map((category) => (
                  <label key={category} className="flex items-center gap-2 text-body-sm text-text-primary">
                    <input
                      type="checkbox"
                      checked={categories.includes(category)}
                      onChange={() =>
                        setCategories((current) =>
                          current.includes(category) ? current.filter((item) => item !== category) : [...current, category],
                        )
                      }
                      className="h-4 w-4"
                    />
                    {category}
                  </label>
                ))}
              </div>
              {errors.categories && (
                <span role="alert" className="text-body-sm text-danger-text">
                  {errors.categories}
                </span>
              )}
            </fieldset>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-body-lg text-text-primary">Scenario</legend>
              <div className="flex flex-wrap gap-2">
                {SCENARIOS.map((scenario) => (
                  <button
                    key={scenario.label}
                    type="button"
                    title={scenario.description}
                    className="btn-secondary px-3 py-1"
                    onClick={() => applyScenario(scenario)}
                  >
                    {scenario.label}
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Valid from"
                type="datetime-local"
                value={validFrom}
                onChange={(event) => setValidFrom(event.target.value)}
                error={errors.valid_from}
              />
              <TextField
                label="Valid until"
                type="datetime-local"
                value={validTo}
                onChange={(event) => setValidTo(event.target.value)}
                error={errors.valid_to}
              />
            </div>
            <SelectField
              label="Status"
              options={[
                { value: 'granted', label: 'Granted' },
                { value: 'revoked', label: 'Revoked' },
              ]}
              value={status}
              onChange={(event) => setStatus(event.target.value === 'revoked' ? 'revoked' : 'granted')}
            />

            {formError && (
              <p role="alert" className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-body-sm text-danger-text">
                {formError}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <button type="button" className="btn-secondary" disabled={submitting}>
                  Cancel
                </button>
              </Dialog.Close>
              <button type="submit" className="btn-primary disabled:opacity-60" disabled={submitting}>
                {submitting && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
                Add consent
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
