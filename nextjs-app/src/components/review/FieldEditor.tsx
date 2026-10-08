'use client'

import { useQuery } from '@tanstack/react-query'
import { Loader2, Search } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { SelectField, TextField } from '@/components/ui/fields'
import { searchTerminology } from '@/lib/api/review'
import type { DraftDecision } from '@/lib/review/draft'
import { cn } from '@/lib/utils/cn'
import type { CodeSystem } from '@/types/domain'
import type { WorkspaceField } from '@/types/review'

type Code = NonNullable<DraftDecision['code']>

interface CodePickerProps {
  field: WorkspaceField
  resourceType: string
  system: CodeSystem
  value: Code | undefined
  onChange: (code: Code | undefined) => void
}

/** Reviewers pick a code from the model's candidates or a terminology search; they never type a code. */
function CodePicker({ field, resourceType, system, value, onChange }: CodePickerProps) {
  const searchId = useId()
  const [term, setTerm] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(term.trim()), 300)
    return () => window.clearTimeout(handle)
  }, [term])

  const search = useQuery({
    queryKey: ['terminology', system, resourceType, debounced],
    queryFn: () => searchTerminology(debounced, system, resourceType),
    enabled: debounced.length >= 2,
    staleTime: 5 * 60_000,
  })

  const candidates = (field.coding?.candidates ?? []).map((candidate) => ({ system, code: candidate.code, display: candidate.display }))
  const options = [...candidates, ...(search.data ?? []).filter((hit) => !candidates.some((candidate) => candidate.code === hit.code)).map((hit) => ({ system, code: hit.code, display: hit.display }))]

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-body-lg text-text-primary">Code ({system.toUpperCase()})</legend>
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
        <input
          id={searchId}
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Search the terminology"
          aria-label="Search the terminology"
          className="w-full rounded-md border border-border bg-bg-primary py-2 pl-9 pr-3 text-body-lg text-text-primary focus:border-border-brand"
        />
      </div>
      <div role="radiogroup" aria-label="Codes" className="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {search.isFetching && (
          <span className="inline-flex items-center gap-2 text-body-sm text-text-secondary">
            <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            Searching
          </span>
        )}
        {options.length === 0 && !search.isFetching && (
          <span className="text-body-sm text-text-secondary">
            {debounced.length >= 2 ? 'No matching codes. Try other words.' : 'No suggested codes. Search to find one.'}
          </span>
        )}
        {options.map((option) => {
          const selected = value?.code === option.code && value.system === option.system
          return (
            <button
              key={`${option.system}-${option.code}`}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(selected ? undefined : option)}
              className={cn(
                'flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-left text-body-sm transition-colors duration-fast',
                selected ? 'border-border-brand bg-brand-subtle text-text-primary' : 'border-border bg-bg-primary text-text-primary hover:bg-bg-subtle',
              )}
            >
              <span>{option.display}</span>
              <span className="shrink-0 font-mono text-text-secondary">{option.code}</span>
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}

interface FieldEditorProps {
  field: WorkspaceField
  resourceType: string
  initial?: DraftDecision
  error?: string
  onSave: (decision: DraftDecision) => void
  onCancel: () => void
}

/** Inline editor for a correction: the value, an optional code, and a short note. Enter saves, Escape cancels. */
export function FieldEditor({ field, resourceType, initial, error, onSave, onCancel }: FieldEditorProps) {
  const [value, setValue] = useState(initial?.value ?? (field.found && field.value !== null ? String(field.value) : ''))
  const [code, setCode] = useState<Code | undefined>(initial?.code)
  const [note, setNote] = useState(initial?.note ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const firstRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null)
  useEffect(() => {
    firstRef.current?.focus()
  }, [])

  function submit(event: FormEvent) {
    event.preventDefault()
    const changedValue = value.trim() !== (field.found && field.value !== null ? String(field.value) : '')
    if (!changedValue && !code) {
      setProblem('Change the value or choose a code first.')
      return
    }
    onSave({ action: 'correct', ...(changedValue ? { value: value.trim() } : {}), ...(code ? { code } : {}), ...(note.trim() ? { note: note.trim() } : {}) })
  }

  const id = `${field.field_key}-value`
  return (
    <form
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel()
        }
      }}
      className="flex flex-col gap-3 rounded-md border border-border-brand bg-bg-surface p-3"
      aria-label={`Correct ${field.label}`}
    >
      {field.choices ? (
        <SelectField
          id={id}
          ref={(element) => {
            firstRef.current = element
          }}
          label="Corrected value"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          options={[{ value: '', label: 'Choose…' }, ...field.choices.map((choice) => ({ value: choice, label: choice }))]}
        />
      ) : (
        <TextField
          id={id}
          ref={(element) => {
            firstRef.current = element
          }}
          label="Corrected value"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          hint={field.kind === 'date' ? 'Use a date like 2025-03-01.' : field.kind === 'number' ? 'Enter a number.' : undefined}
        />
      )}
      {field.codeable && <CodePicker field={field} resourceType={resourceType} system={field.codeable.system} value={code} onChange={setCode} />}
      <TextField label="Note (optional)" value={note} maxLength={300} onChange={(event) => setNote(event.target.value)} hint="For example: printed as BID." />
      {(problem ?? error) && (
        <p role="alert" className="text-body-sm text-danger-text">
          {problem ?? error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className="btn-primary px-3 py-1">
          Save correction
        </button>
        <button type="button" className="btn-secondary px-3 py-1" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
