'use client'

import { useQuery } from '@tanstack/react-query'
import { Search, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { EventMultiSelect } from '@/components/audit/EventMultiSelect'
import { SelectField, TextField } from '@/components/ui/fields'
import { fetchSourcesPage } from '@/lib/api/sources'
import { queryKeys } from '@/lib/api/queryKeys'
import { auditFiltersSchema, type AuditFilters } from '@/lib/validation/audit'
import type { AuditEvent } from '@/types/audit'

interface AuditFilterBarProps {
  onApply: (filters: AuditFilters) => void
}

interface Draft {
  recordId: string
  sourceId: string
  identifierType: 'abha' | 'mrn'
  identifierValue: string
  events: AuditEvent[]
  from: string
  to: string
}

const EMPTY: Draft = {
  recordId: '',
  sourceId: '',
  identifierType: 'abha',
  identifierValue: '',
  events: [],
  from: '',
  to: '',
}

/** `datetime-local` gives a local wall-clock value; the API wants an absolute ISO instant. */
function toIso(value: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export function AuditFilterBar({ onApply }: AuditFilterBarProps) {
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const sources = useQuery({
    queryKey: queryKeys.sourceOptions,
    queryFn: () => fetchSourcesPage(undefined, 100),
    staleTime: 60_000,
  })

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const candidate = {
      record_id: draft.recordId.trim() || undefined,
      source_id: draft.sourceId || undefined,
      patient_identifier: draft.identifierValue.trim()
        ? { type: draft.identifierType, value: draft.identifierValue.trim() }
        : undefined,
      events: draft.events.length > 0 ? draft.events : undefined,
      from: toIso(draft.from),
      to: toIso(draft.to),
    }
    const parsed = auditFiltersSchema.safeParse(candidate)
    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form')
        next[key] ??= issue.path[0] === 'record_id' ? 'Enter a valid record ID (UUID)' : issue.message
      }
      setErrors(next)
      return
    }
    setErrors({})
    onApply(parsed.data)
  }

  function reset() {
    setDraft(EMPTY)
    setErrors({})
    onApply({})
  }

  const sourceOptions = [
    { value: '', label: 'All sources' },
    ...(sources.data?.sources ?? []).map((source) => ({ value: source.id, label: source.name })),
  ]

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="Audit filters"
      className="flex flex-col gap-4 rounded-lg border border-border bg-bg-primary p-4"
    >
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <TextField
          label="Record ID"
          autoComplete="off"
          placeholder="UUID"
          value={draft.recordId}
          onChange={(event) => update('recordId', event.target.value)}
          error={errors.record_id}
        />
        <SelectField
          label="Source"
          options={sourceOptions}
          value={draft.sourceId}
          onChange={(event) => update('sourceId', event.target.value)}
          error={errors.source_id}
        />
        <div className="flex flex-col gap-1">
          <span className="text-body-lg text-text-primary">Event types</span>
          <EventMultiSelect selected={draft.events} onChange={(events) => update('events', events)} />
        </div>
        <div className="grid grid-cols-[7rem_1fr] gap-2">
          <SelectField
            label="Patient ID"
            options={[
              { value: 'abha', label: 'ABHA' },
              { value: 'mrn', label: 'MRN' },
            ]}
            value={draft.identifierType}
            onChange={(event) => update('identifierType', event.target.value === 'mrn' ? 'mrn' : 'abha')}
          />
          <TextField
            label="Identifier"
            autoComplete="off"
            value={draft.identifierValue}
            onChange={(event) => update('identifierValue', event.target.value)}
            error={errors.patient_identifier}
            hint="Matched by hash; never shown or logged"
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <TextField
          label="From"
          type="datetime-local"
          value={draft.from}
          onChange={(event) => update('from', event.target.value)}
          error={errors.from}
        />
        <TextField
          label="To"
          type="datetime-local"
          value={draft.to}
          onChange={(event) => update('to', event.target.value)}
          error={errors.to}
        />
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={reset}>
          <X aria-hidden="true" className="h-4 w-4" />
          Reset
        </button>
        <button type="submit" className="btn-primary">
          <Search aria-hidden="true" className="h-4 w-4" />
          Search
        </button>
      </div>
    </form>
  )
}
