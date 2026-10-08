'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, TriangleAlert, X } from 'lucide-react'
import Link from 'next/link'
import { formatAuditTime } from '@/components/audit/format'
import { ErrorState } from '@/components/shared/ErrorState'
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton'
import { fetchReconstruction } from '@/lib/api/ingestions'
import { queryKeys } from '@/lib/api/queryKeys'
import { reasonLabel } from '@/lib/records/reasons'
import { fieldLabel, RESOURCE_LABELS } from '@/lib/review/labels'
import type { Reconstruction } from '@/types/trace'

const show = (value: unknown) => (value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value))

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h3 className="text-body-lg text-text-primary">{title}</h3>
      {children}
    </section>
  )
}

function Facts({ items }: { items: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body-sm">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-text-secondary">{label}</dt>
          <dd className="break-words text-text-primary">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Summary({ data }: { data: Reconstruction }) {
  const { consent, ocr, extraction, mapping, validation, scores, routing, review, commit } = data
  return (
    <div className="flex flex-col gap-5">
      <Section title="Outcome">
        <Facts
          items={[
            ['Status', `${data.record.status.replaceAll('_', ' ')}${data.record.status_reason ? ` (${reasonLabel(data.record.status_reason)})` : ''}`],
            ['Source', `${data.record.source.name} · ${data.record.doc_type.replaceAll('_', ' ')} · ${data.record.input_kind}`],
            ['Received', formatAuditTime(data.record.created_at)],
            ['Completed', data.record.completed_at ? formatAuditTime(data.record.completed_at) : 'Not finished'],
            ['Cost', `$${data.record.cost_usd.toFixed(4)}`],
            ...(data.record.holdback ? ([['Audit sample', 'Yes: this record would have auto-committed']] as [string, string][]) : []),
          ]}
        />
      </Section>

      <Section title="Consent">
        {consent ? (
          <Facts items={[['Result', consent.result], ['Regime', consent.regime.toUpperCase()], ['Requested', consent.required.join(', ')], ['Covered', consent.matched_scope.join(', ') || 'None'], ['Artifact', consent.artifact_ref ?? 'None'], ['Checked', formatAuditTime(consent.checked_at)]]} />
        ) : (
          <p className="text-body-sm text-text-secondary">No consent check was recorded.</p>
        )}
      </Section>

      <Section title="Reading and extraction">
        <Facts
          items={[
            ['Scan quality', ocr ? (ocr.confidence === null ? 'Digital text' : `${Math.round(ocr.confidence * 100)}%${ocr.engine ? ` (${ocr.engine})` : ''}`) : 'Not recorded'],
            ['Model', extraction?.model_id ?? 'Not recorded'],
            ['Prompts', extraction && Object.keys(extraction.prompt_versions).length > 0 ? Object.entries(extraction.prompt_versions).map(([name, id]) => `${name}: ${id.slice(0, 8)}`).join(', ') : 'Not recorded'],
            ['Values found', extraction ? `${show(extraction.fields_found)} found, ${show(extraction.fields_not_found)} not found` : 'Not recorded'],
            ['Injection suspected', extraction ? (extraction.injection_suspected ? 'Yes' : 'No') : 'Not recorded'],
          ]}
        />
      </Section>

      <Section title="Mapping and validation">
        <Facts items={[['Resources', mapping ? `${show(mapping.resources)} built, ${show(mapping.coded)} coded, ${show(mapping.uncoded)} uncoded` : 'Not recorded']]} />
        {validation.length > 0 && (
          <ul className="flex flex-col gap-1 text-body-sm">
            {validation.map((entry, index) => (
              <li key={index} className="text-text-primary">
                {RESOURCE_LABELS[entry.resource_type] ?? entry.resource_type}: {entry.status}
                {entry.error_count > 0 ? `, ${entry.error_count} error${entry.error_count === 1 ? '' : 's'}` : ''}
                {entry.flags.length > 0 ? ` · flags: ${entry.flags.join(', ')}` : ''}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Scores and routing">
        <Facts items={[['Record score', scores.aggregate === null ? 'Not scored' : scores.aggregate.toFixed(3)], ['Decision', routing ? `${routing.decision.replaceAll('_', ' ')} (rule ${routing.rule_version})` : 'Not routed'], ['Reasons', routing && routing.reasons.length > 0 ? routing.reasons.map(reasonLabel).join(', ') : 'None']]} />
        {scores.resources.length > 0 && (
          <ul className="flex flex-col gap-1 text-body-sm">
            {scores.resources.map((entry, index) => (
              <li key={index} className="text-text-primary">
                {RESOURCE_LABELS[entry.resource_type] ?? entry.resource_type}: {entry.score.toFixed(3)}
                {entry.threshold !== null ? ` against ${entry.threshold.toFixed(3)} (${entry.pass ? 'passed' : 'below'})` : ''}
              </li>
            ))}
          </ul>
        )}
        {routing?.trace && <p className="text-body-sm text-text-secondary">{routing.trace}</p>}
      </Section>

      {(review.tasks.length > 0 || review.corrections.length > 0) && (
        <Section title="Review">
          {review.tasks.map((task, index) => (
            <p key={index} className="text-body-sm text-text-primary">
              {task.kind.replaceAll('_', ' ')} task, {task.status}
              {task.claimed_by_name ? `, reviewer ${task.claimed_by_name}` : ''}
              {task.claimed_at && task.completed_at ? `, ${Math.max(1, Math.round((Date.parse(task.completed_at) - Date.parse(task.claimed_at)) / 60_000))} min` : ''}
            </p>
          ))}
          {review.corrections.filter((entry) => entry.action !== 'accept').length === 0 && review.corrections.length > 0 && <p className="text-body-sm text-text-secondary">The reviewer accepted every field.</p>}
          <ul className="flex flex-col gap-1">
            {review.corrections
              .filter((entry) => entry.action !== 'accept')
              .map((entry, index) => (
                <li key={index} className="rounded-md border border-border bg-bg-surface px-3 py-2 text-body-sm text-text-primary">
                  <span className="font-medium">{fieldLabel(entry.field_key)}</span>: {entry.action === 'reject' ? `rejected (was ${show(entry.original_value)})` : `${show(entry.original_value)} → ${show(entry.corrected_value ?? entry.corrected_code)}`}
                  {entry.note && <span className="block text-text-secondary">Note: {entry.note}</span>}
                </li>
              ))}
          </ul>
        </Section>
      )}

      <Section title="Commit">
        {commit ? (
          <Facts items={[['Mode', commit.mode === 'auto' ? 'Automatic' : 'Reviewed by a person'], ['Committed', formatAuditTime(commit.committed_at)], ['Resources', `${commit.resource_ids.length}`]]} />
        ) : (
          <p className="text-body-sm text-text-secondary">Nothing was committed.</p>
        )}
      </Section>
    </div>
  )
}

function Chain({ data }: { data: Reconstruction }) {
  return (
    <Section title="Audit chain">
      <ol className="flex flex-col border-l border-border pl-4">
        {data.chain.map((row) => (
          <li key={row.id} className="relative flex flex-col gap-1 pb-4">
            <span aria-hidden="true" className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-brand" />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-body-sm text-text-primary">{row.event}</span>
              <span className="text-body-sm text-text-secondary">{formatAuditTime(row.created_at)}</span>
            </div>
            <span className="text-body-sm text-text-secondary">
              {row.actor_name ?? (row.actor_type === 'system' ? 'System' : row.actor_id ?? row.actor_type)} · entry #{row.id}
            </span>
            <details>
              <summary className="cursor-pointer text-body-sm text-text-secondary">Details</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-border bg-bg-surface p-2 font-mono text-body-sm text-text-primary">{JSON.stringify(row.payload, null, 2)}</pre>
            </details>
            <span className={row.hash_ok ? 'inline-flex items-center gap-1 text-body-sm text-success-text' : 'inline-flex items-center gap-1 text-body-sm text-danger-text'}>
              {row.hash_ok ? <CheckCircle2 aria-hidden="true" className="h-3 w-3" /> : <TriangleAlert aria-hidden="true" className="h-3 w-3" />}
              {row.hash_ok ? `Verified (${row.hash_short}…)` : 'Verification failed'}
            </span>
          </li>
        ))}
      </ol>
    </Section>
  )
}

interface AuditTimelineProps {
  recordId: string | null
  onOpenChange: (open: boolean) => void
}

/** "Why was this record committed or escalated": a drawer with the chain and what each stage stored. Admin only. */
export function AuditTimeline({ recordId, onOpenChange }: AuditTimelineProps) {
  const query = useQuery({
    queryKey: queryKeys.reconstruction(recordId ?? 'none'),
    queryFn: () => fetchReconstruction(recordId as string),
    enabled: recordId !== null,
    retry: false,
    staleTime: 0,
  })
  const broken = query.data?.chain.filter((row) => !row.hash_ok) ?? []

  return (
    <Dialog.Root open={recordId !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-text-primary opacity-40" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col gap-4 overflow-y-auto border-l border-border bg-bg-primary p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-h5 text-text-primary">Why this record ended up here</Dialog.Title>
              <Dialog.Description className="text-body-sm text-text-secondary">
                The audit chain joined with what each step stored.{' '}
                {recordId && (
                  <Link href={`/records/${recordId}`} className="text-brand hover:underline">
                    Open the record
                  </Link>
                )}
              </Dialog.Description>
            </div>
            <Dialog.Close aria-label="Close" className="rounded-md p-1 text-text-secondary hover:bg-bg-subtle">
              <X aria-hidden="true" className="h-4 w-4" />
            </Dialog.Close>
          </div>

          {query.isPending && (
            <div aria-busy="true" className="flex flex-col gap-3">
              <Skeleton className="h-6 w-48" />
              <SkeletonText lines={8} />
            </div>
          )}
          {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
          {query.data && (
            <>
              {broken.length > 0 && (
                <p role="alert" className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-body-sm text-danger-text">
                  Audit integrity check failed at entr{broken.length === 1 ? 'y' : 'ies'} #{broken.map((row) => row.id).join(', #')}. Contact security.
                </p>
              )}
              <Summary data={query.data} />
              <Chain data={query.data} />
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
