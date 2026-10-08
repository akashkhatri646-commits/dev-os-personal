'use client'

import { Bot, ExternalLink, UserCheck } from 'lucide-react'
import { useState } from 'react'
import { AiExtractedTag } from '@/components/shared/AiExtractedTag'
import { ConfidenceBar } from '@/components/shared/ConfidenceBar'
import { EmptyState } from '@/components/shared/EmptyState'
import { useToast } from '@/components/ui/Toaster'
import { ApiError } from '@/lib/api/errors'
import { fetchDocumentLink } from '@/lib/api/ingestions'
import { reasonLabel } from '@/lib/records/reasons'
import { concernLabel, RESOURCE_LABELS } from '@/lib/review/labels'
import type { RecordDetail } from '@/types/records'
import type { ProvenanceView, RecordTrace } from '@/types/trace'

const timeFormatter = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
const when = (iso: string) => `${timeFormatter.format(new Date(iso))} UTC`

/** Every extracted value with its citation, score and caps. Read only: corrections happen in review. */
export function FieldsTab({ trace }: { trace: RecordTrace }) {
  if (trace.resources.length === 0) {
    return <EmptyState title="No fields were extracted" description="Nothing was read from this document, or its data was removed." />
  }
  return (
    <div className="flex flex-col gap-4">
      {trace.resources.map((resource) => (
        <section key={resource.id} className="flex flex-col gap-2" aria-label={RESOURCE_LABELS[resource.resource_type] ?? resource.resource_type}>
          <h3 className="text-body-lg text-text-primary">{RESOURCE_LABELS[resource.resource_type] ?? resource.resource_type}</h3>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[40rem] text-left text-body-sm">
              <caption className="sr-only">Fields of {RESOURCE_LABELS[resource.resource_type] ?? resource.resource_type}</caption>
              <thead className="bg-bg-surface text-text-secondary">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Field</th>
                  <th scope="col" className="px-3 py-2 font-medium">Value</th>
                  <th scope="col" className="px-3 py-2 font-medium">Cited text</th>
                  <th scope="col" className="w-48 px-3 py-2 font-medium">Score</th>
                </tr>
              </thead>
              <tbody>
                {resource.fields.map((field) => (
                  <tr key={field.field_key} className="border-t border-border align-top">
                    <th scope="row" className="px-3 py-2 font-normal text-text-primary">{field.label}</th>
                    <td className="px-3 py-2 text-text-primary">
                      {field.found && field.value !== null ? String(field.value) : <span className="italic text-text-secondary">Not found</span>}
                      {field.coding && <span className="mt-1 block font-mono text-text-secondary">{field.coding.code} · {field.coding.display}</span>}
                    </td>
                    <td className="px-3 py-2 text-text-secondary">
                      {field.span?.quote ? `“${field.span.quote}”${field.span.page > 0 ? ` (page ${field.span.page})` : ''}` : field.span?.manual ? 'Supplied by a reviewer' : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <ConfidenceBar score={field.score} {...(resource.threshold !== null ? { threshold: resource.threshold } : {})} />
                      <div className="mt-1 flex flex-wrap gap-1">
                        {field.concerns.map((concern) => (
                          <span key={concern} className="badge-warning">{concernLabel(concern)}</span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  )
}

/** The FHIR resources, readable first and as raw JSON on request. Drafts are labelled as such. */
export function FhirTab({ trace }: { trace: RecordTrace }) {
  const [open, setOpen] = useState<string | null>(null)
  if (trace.fhir.length === 0) return <EmptyState title="No FHIR resources" description="Resources are built once fields are mapped." />
  return (
    <ul className="flex flex-col gap-3">
      {trace.fhir.map((entry) => (
        <li key={entry.id} className="flex flex-col gap-2 rounded-md border border-border bg-bg-primary p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-body-lg text-text-primary">{RESOURCE_LABELS[entry.resource_type] ?? entry.resource_type}</span>
            <div className="flex items-center gap-2">
              <AiExtractedTag />
              <span className={entry.committed ? 'badge-success' : 'badge-warning'}>{entry.committed ? `Committed (v${entry.version_id ?? 1})` : 'Draft, not committed'}</span>
            </div>
          </div>
          <p className="font-mono text-body-sm text-text-secondary">{entry.resource_type}/{entry.id}</p>
          <button type="button" className="w-fit text-body-sm text-brand hover:underline" aria-expanded={open === entry.id} onClick={() => setOpen(open === entry.id ? null : entry.id)}>
            {open === entry.id ? 'Hide JSON' : 'Show JSON'}
          </button>
          {open === entry.id && (
            <pre className="max-h-96 overflow-auto rounded-md border border-border bg-bg-surface p-3 font-mono text-body-sm text-text-primary">{JSON.stringify(entry.resource, null, 2)}</pre>
          )}
        </li>
      ))}
    </ul>
  )
}

export function DecisionTab({ trace }: { trace: RecordTrace }) {
  const { decision } = trace
  if (!decision) return <EmptyState title="No routing decision yet" description="The decision is made after the record is scored." />
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <section className="flex flex-col gap-2" aria-label="Aggregate score">
        <h3 className="text-body-lg text-text-primary">Record score</h3>
        <ConfidenceBar score={decision.aggregate_score} />
        <div className="flex flex-wrap gap-1">
          {decision.reasons.length === 0 ? <span className="badge-success">No reasons to escalate</span> : decision.reasons.map((reason) => <span key={reason} className="badge-warning">{reasonLabel(reason)}</span>)}
        </div>
      </section>
      <section className="flex flex-col gap-2" aria-label="Thresholds">
        <h3 className="text-body-lg text-text-primary">Score against threshold</h3>
        <ul className="flex flex-col gap-2">
          {Object.entries(decision.thresholds_applied).map(([type, applied]) => (
            <li key={type} className="flex flex-col gap-1">
              <span className="text-body-sm text-text-secondary">{RESOURCE_LABELS[type] ?? type} (rule v{applied.version})</span>
              <ConfidenceBar score={applied.score} threshold={applied.threshold} />
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-1" aria-label="Reasoning">
        <h3 className="text-body-lg text-text-primary">Reasoning</h3>
        <p className="text-body-sm text-text-secondary">{decision.reasoning_trace}</p>
      </section>
    </div>
  )
}

export function ConsentTab({ detail }: { detail: RecordDetail }) {
  const consent = detail.consent
  if (!consent) return <EmptyState title="Consent not checked yet" description="The consent check runs before anything is read." />
  return (
    <dl className="grid max-w-2xl gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-0.5">
        <dt className="text-body-lg text-text-primary">Result</dt>
        <dd><span className={consent.result === 'valid' ? 'badge-success' : 'badge-danger'}>{consent.result.replaceAll('_', ' ')}</span></dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-body-lg text-text-primary">Regime</dt>
        <dd className="text-body-sm text-text-secondary">{consent.regime.toUpperCase()}</dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-body-lg text-text-primary">Data requested</dt>
        <dd className="text-body-sm text-text-secondary">{consent.required_categories.join(', ')}</dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-body-lg text-text-primary">Covered by consent</dt>
        <dd className="text-body-sm text-text-secondary">{consent.matched_scope.length > 0 ? consent.matched_scope.join(', ') : 'None'}</dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-body-lg text-text-primary">Checked</dt>
        <dd className="text-body-sm text-text-secondary">{when(consent.checked_at)}</dd>
      </div>
    </dl>
  )
}

/** How a committed resource was produced: the method, model, prompts, consent, reviewer and time. */
export function ProvenanceCard({ item }: { item: ProvenanceView }) {
  const human = item.extraction_method === 'ai_extracted_human_reviewed'
  return (
    <section className="flex flex-col gap-3 rounded-md border border-border bg-bg-primary p-4" aria-label={`Provenance of ${item.resource_type}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-body-lg text-text-primary">{RESOURCE_LABELS[item.resource_type] ?? item.resource_type}</h3>
        <span className="flex flex-wrap items-center gap-2">
          <AiExtractedTag />
          <span className={human ? 'badge-success' : 'badge-info'}>
          {human ? <UserCheck aria-hidden="true" className="h-3 w-3" /> : <Bot aria-hidden="true" className="h-3 w-3" />}
          {human ? 'Reviewed by a person' : 'Committed automatically'}
          </span>
        </span>
      </div>
      <dl className="grid gap-3 text-body-sm sm:grid-cols-2">
        <div><dt className="text-text-secondary">Model</dt><dd className="text-text-primary">{item.model_id ?? 'Not recorded'}</dd></div>
        <div><dt className="text-text-secondary">Prompt versions</dt><dd className="text-text-primary">{Object.keys(item.prompt_versions).length > 0 ? Object.entries(item.prompt_versions).map(([name, id]) => `${name}: ${id.slice(0, 8)}`).join(', ') : 'Not recorded'}</dd></div>
        <div><dt className="text-text-secondary">Consent reference</dt><dd className="text-text-primary">{item.consent_artifact_ref ?? 'Not recorded'}</dd></div>
        <div><dt className="text-text-secondary">Reviewer</dt><dd className="text-text-primary">{item.reviewer_name ?? 'None (automatic)'}</dd></div>
        <div><dt className="text-text-secondary">Committed</dt><dd className="text-text-primary">{when(item.committed_at)}</dd></div>
        <div><dt className="text-text-secondary">Values with a citation</dt><dd className="text-text-primary">{item.field_count}</dd></div>
      </dl>
    </section>
  )
}

export function ProvenanceTab({ trace }: { trace: RecordTrace }) {
  if (trace.provenance.length === 0) return <EmptyState title="Nothing committed yet" description="Provenance is recorded when resources are committed." />
  return <div className="flex flex-col gap-3">{trace.provenance.map((item) => <ProvenanceCard key={item.resource_id} item={item} />)}</div>
}

/** Opens the original through a short-lived link. Not offered for records whose consent blocked them. */
export function SourceTab({ detail }: { detail: RecordDetail }) {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  if (detail.status === 'blocked_consent') {
    return <EmptyState title="The document cannot be shown" description="Consent did not allow this record, so its content is not available." />
  }
  if (!detail.document) return <EmptyState title="No stored document" description="The original is not available." />

  async function open() {
    setBusy(true)
    try {
      const link = await fetchDocumentLink(detail.id)
      window.open(link.url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      toast({ title: 'Could not open the document', description: error instanceof ApiError ? error.message : 'Try again.', tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <dl className="grid gap-3 text-body-sm sm:grid-cols-2">
        <div><dt className="text-text-secondary">Type</dt><dd className="text-text-primary">{detail.document.mime_type}</dd></div>
        <div><dt className="text-text-secondary">Size</dt><dd className="text-text-primary">{(detail.document.bytes / 1024).toFixed(0)} KB</dd></div>
        <div><dt className="text-text-secondary">Pages</dt><dd className="text-text-primary">{detail.document.page_count ?? 'Not applicable'}</dd></div>
        <div><dt className="text-text-secondary">Scan quality</dt><dd className="text-text-primary">{detail.document.ocr_confidence === null ? 'Digital text' : `${Math.round(detail.document.ocr_confidence * 100)}%${detail.document.ocr_engine ? ` (${detail.document.ocr_engine})` : ''}`}</dd></div>
      </dl>
      <button type="button" className="btn-secondary w-fit" onClick={() => void open()} disabled={busy}>
        <ExternalLink aria-hidden="true" className="h-4 w-4" />
        Open the original
      </button>
      <p className="text-body-sm text-text-secondary">The link works for a few minutes. Opening the document is recorded in the audit log.</p>
    </div>
  )
}
