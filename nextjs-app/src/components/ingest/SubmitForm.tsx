'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, CopyCheck, FileUp, Loader2, TriangleAlert, X } from 'lucide-react'
import Link from 'next/link'
import { useId, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { SelectField, TextField } from '@/components/ui/fields'
import { EmptyState } from '@/components/shared/EmptyState'
import { Tabs, TabPanel } from '@/components/ui/Tabs'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toaster'
import { ApiError } from '@/lib/api/errors'
import { submitRecord } from '@/lib/api/ingestions'
import { queryKeys } from '@/lib/api/queryKeys'
import { fetchSourcesPage } from '@/lib/api/sources'
import {
  DATA_CATEGORIES,
  MAX_TEXT_CHARS,
  submitIngestionSchema,
  type DataCategory,
} from '@/lib/validation/ingestion'
import { cn } from '@/lib/utils/cn'
import type { PatientIdentifierType } from '@/lib/validation/patientIdentifier'

const MAX_FILE_BYTES = 25 * 1024 * 1024
const ALLOWED_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'hl7', 'txt']
const ACCEPT = ALLOWED_EXTENSIONS.map((extension) => `.${extension}`).join(',')

type ItemState = 'queued' | 'uploading' | 'done' | 'duplicate' | 'error'
interface UploadItem {
  id: string
  file: File
  state: ItemState
  message?: string
}

const TABS = [
  { id: 'file', label: 'Upload files' },
  { id: 'text', label: 'Paste text or HL7' },
] as const

function extensionOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function uploadError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'PAYLOAD_TOO_LARGE') return error.message
    return error.message
  }
  return 'Upload failed. Try again.'
}

export function SubmitForm() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const inputId = useId()
  const fileInput = useRef<HTMLInputElement>(null)

  const [tab, setTab] = useState<string>('file')
  const [sourceId, setSourceId] = useState('')
  const [identifierType, setIdentifierType] = useState<PatientIdentifierType>('abha')
  const [identifierValue, setIdentifierValue] = useState('')
  const [categories, setCategories] = useState<DataCategory[]>(['DischargeSummary'])
  const [text, setText] = useState('')
  const [items, setItems] = useState<UploadItem[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [dragging, setDragging] = useState(false)

  const sources = useQuery({
    queryKey: queryKeys.sourceOptions,
    queryFn: () => fetchSourcesPage(undefined, 100),
    staleTime: 60_000,
  })

  // Only sources that accept discharge summaries (the one document type enabled in the MVP).
  const eligible = (sources.data?.sources ?? []).filter((source) => source.doc_types.includes('discharge_summary'))
  const selectedSource = eligible.find((source) => source.id === sourceId) ?? eligible[0]
  const effectiveSourceId = selectedSource?.id ?? ''

  function addFiles(list: FileList | File[]) {
    const added: UploadItem[] = Array.from(list).map((file) => {
      const base = { id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`, file }
      if (!ALLOWED_EXTENSIONS.includes(extensionOf(file.name))) {
        return { ...base, state: 'error', message: 'Unsupported type. Use PDF, PNG, JPEG, TIFF, HL7 or text.' }
      }
      if (file.size === 0) return { ...base, state: 'error', message: 'The file is empty.' }
      if (file.size > MAX_FILE_BYTES) return { ...base, state: 'error', message: 'Larger than the 25 MB limit.' }
      return { ...base, state: 'queued' }
    })
    setItems((current) => [...current, ...added])
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    setDragging(false)
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files)
  }

  function patchItem(id: string, patch: Partial<UploadItem>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  function toggleCategory(category: DataCategory) {
    setCategories((current) =>
      current.includes(category) ? current.filter((item) => item !== category) : [...current, category],
    )
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const parsed = submitIngestionSchema.safeParse({
      source_id: effectiveSourceId,
      patient_identifier: { type: identifierType, value: identifierValue.trim() },
      doc_type: 'discharge_summary',
      data_categories: categories,
    })
    const nextErrors: Record<string, string> = {}
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] === 'patient_identifier' ? 'identifier' : String(issue.path[0])
        nextErrors[key] ??= issue.path[0] === 'source_id' ? 'Choose a source' : issue.message
      }
    }
    const queued = items.filter((item) => item.state === 'queued')
    if (tab === 'file' && queued.length === 0) nextErrors.content = 'Add at least one valid file'
    if (tab === 'text' && text.trim().length === 0) nextErrors.content = 'Paste the text or HL7 message'
    setErrors(nextErrors)
    if (!parsed.success || Object.keys(nextErrors).length > 0) return

    setSubmitting(true)
    let accepted = 0
    let duplicates = 0
    let failed = 0
    try {
      if (tab === 'text') {
        try {
          const result = await submitRecord({ meta: parsed.data, text })
          if (result.duplicate) duplicates += 1
          else accepted += result.record_ids.length
          setText('')
        } catch (error) {
          failed += 1
          setErrors({ content: uploadError(error) })
        }
      } else {
        // One request per file, in order, so a bad file never blocks the others.
        for (const item of queued) {
          patchItem(item.id, { state: 'uploading', message: undefined })
          try {
            const result = await submitRecord({ meta: parsed.data, file: item.file })
            if (result.duplicate) {
              duplicates += 1
              patchItem(item.id, { state: 'duplicate', message: 'Already submitted; nothing new was created.' })
            } else {
              accepted += result.record_ids.length
              patchItem(item.id, { state: 'done', message: 'Accepted for processing.' })
            }
          } catch (error) {
            failed += 1
            patchItem(item.id, { state: 'error', message: uploadError(error) })
          }
        }
      }
    } finally {
      setSubmitting(false)
      await queryClient.invalidateQueries({ queryKey: queryKeys.records })
    }

    if (accepted > 0 || duplicates > 0) {
      toast({
        title: accepted > 0 ? `${accepted} record${accepted === 1 ? '' : 's'} submitted` : 'Nothing new to process',
        description: [
          duplicates > 0 ? `${duplicates} already submitted` : null,
          failed > 0 ? `${failed} failed` : null,
        ]
          .filter(Boolean)
          .join(', ') || undefined,
        tone: failed > 0 ? 'danger' : 'success',
      })
    }
  }

  if (sources.isPending) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-bg-primary p-6" aria-busy="true">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    )
  }

  if (eligible.length === 0) {
    return (
      <EmptyState
        title="Create a source first"
        description="Records are submitted for a provider source that accepts discharge summaries."
        action={
          <Link href="/sources/new" className="btn-primary">
            New source
          </Link>
        }
      />
    )
  }

  const queuedCount = items.filter((item) => item.state === 'queued').length

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="flex flex-col gap-4 rounded-lg border border-border bg-bg-primary p-6"
      aria-label="Submit records"
    >
      <h2 className="text-h5 text-text-primary">Submit records</h2>

      <SelectField
        label="Source"
        options={eligible.map((source) => ({ value: source.id, label: source.name }))}
        value={effectiveSourceId}
        onChange={(event) => setSourceId(event.target.value)}
        error={errors.source_id}
      />
      {selectedSource && !selectedSource.auto_commit_enabled && (
        <p className="text-body-sm text-text-secondary">
          <span className="badge-neutral mr-2">Manual review only</span>
          Records from this source always go to a reviewer.
        </p>
      )}

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
          hint={identifierType === 'abha' ? '14 digits, hyphens optional' : 'Letters, digits and - _ / .'}
          error={errors.identifier}
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-body-lg text-text-primary">Data categories</legend>
        <p className="text-body-sm text-text-secondary">
          The patient&apos;s consent must cover every category you select.
        </p>
        <div className="grid gap-1 sm:grid-cols-2">
          {DATA_CATEGORIES.map((category) => (
            <label key={category} className="flex items-center gap-2 text-body-sm text-text-primary">
              <input
                type="checkbox"
                checked={categories.includes(category)}
                onChange={() => toggleCategory(category)}
                className="h-4 w-4"
              />
              {category}
            </label>
          ))}
        </div>
        {errors.data_categories && (
          <span role="alert" className="text-body-sm text-danger-text">
            {errors.data_categories}
          </span>
        )}
      </fieldset>

      <Tabs tabs={TABS} active={tab} onChange={setTab} ariaLabel="Submission method" />

      <TabPanel id="file" active={tab}>
        <div className="flex flex-col gap-3">
          <div
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              'flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center transition-colors duration-fast ease-out',
              dragging ? 'border-border-brand bg-brand-subtle' : 'border-border-strong bg-bg-surface',
            )}
          >
            <FileUp aria-hidden="true" className="h-6 w-6 text-text-secondary" />
            <p className="text-body-lg text-text-primary">Drag files here, or</p>
            <button type="button" className="btn-secondary" onClick={() => fileInput.current?.click()}>
              Choose files
            </button>
            <input
              ref={fileInput}
              id={inputId}
              type="file"
              multiple
              accept={ACCEPT}
              className="sr-only"
              aria-label="Choose files to upload"
              onChange={(event) => {
                if (event.target.files) addFiles(event.target.files)
                event.target.value = ''
              }}
            />
            <p className="text-body-sm text-text-secondary">PDF, PNG, JPEG, TIFF, HL7 or text. Up to 25 MB each.</p>
          </div>

          {items.length > 0 && (
            <ul className="flex flex-col gap-2" aria-live="polite" aria-label="Selected files">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-start gap-3 rounded-md border border-border bg-bg-primary px-3 py-2"
                >
                  <ItemIcon state={item.state} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-body-lg text-text-primary">{item.file.name}</span>
                    <span
                      className={cn(
                        'text-body-sm',
                        item.state === 'error' ? 'text-danger-text' : 'text-text-secondary',
                      )}
                    >
                      {formatSize(item.file.size)}
                      {item.message ? ` · ${item.message}` : item.state === 'uploading' ? ' · Uploading…' : ''}
                    </span>
                  </div>
                  {item.state !== 'uploading' && (
                    <button
                      type="button"
                      aria-label={`Remove ${item.file.name}`}
                      onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}
                      className="rounded-md p-1 text-text-secondary hover:bg-bg-subtle"
                    >
                      <X aria-hidden="true" className="h-4 w-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </TabPanel>

      <TabPanel id="text" active={tab}>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${inputId}-text`} className="text-body-lg text-text-primary">
            Clinical note or HL7v2 message
          </label>
          <textarea
            id={`${inputId}-text`}
            rows={8}
            value={text}
            maxLength={MAX_TEXT_CHARS}
            onChange={(event) => setText(event.target.value)}
            className="rounded-md border border-border bg-bg-primary px-3 py-2 font-mono text-body-sm text-text-primary focus:border-border-brand"
          />
          <span className="text-body-sm text-text-secondary">
            {text.length.toLocaleString('en')} / {MAX_TEXT_CHARS.toLocaleString('en')} characters. A message starting with
            MSH| is recognised as HL7v2.
          </span>
        </div>
      </TabPanel>

      {errors.content && (
        <p role="alert" className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-body-sm text-danger-text">
          {errors.content}
        </p>
      )}

      <div className="flex justify-end">
        <button type="submit" className="btn-primary disabled:opacity-60" disabled={submitting}>
          {submitting && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
          {tab === 'file' && queuedCount > 1 ? `Submit ${queuedCount} files` : 'Submit'}
        </button>
      </div>
    </form>
  )
}

function ItemIcon({ state }: { state: ItemState }) {
  const className = 'mt-0.5 h-4 w-4 shrink-0'
  if (state === 'uploading') return <Loader2 aria-hidden="true" className={cn(className, 'animate-spin text-brand')} />
  if (state === 'done') return <CheckCircle2 aria-hidden="true" className={cn(className, 'text-success-text')} />
  if (state === 'duplicate') return <CopyCheck aria-hidden="true" className={cn(className, 'text-info-text')} />
  if (state === 'error') return <TriangleAlert aria-hidden="true" className={cn(className, 'text-danger-text')} />
  return <FileUp aria-hidden="true" className={cn(className, 'text-text-secondary')} />
}
