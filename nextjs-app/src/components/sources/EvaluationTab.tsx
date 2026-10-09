'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, CircleHelp, ClipboardCheck, TriangleAlert, XCircle } from 'lucide-react'
import { useState } from 'react'
import { RoleGate } from '@/components/layout/RoleGate'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { ErrorState } from '@/components/shared/ErrorState'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toaster'
import { fetchEvaluation, runSourceEvaluation } from '@/lib/api/evaluation'
import { queryKeys } from '@/lib/api/queryKeys'
import type { EvalBasis, EvalVerdict, EvaluationView, Rate } from '@/types/evaluation'
import type { SourceDetail } from '@/types/sources'

const PERIODS = [
  { value: 'all', label: 'All time', days: null },
  { value: '90', label: 'Last 90 days', days: 90 },
  { value: '30', label: 'Last 30 days', days: 30 },
] as const

const VERDICT: Record<EvalVerdict, { title: string; className: string; Icon: typeof CheckCircle2 }> = {
  passed: { title: 'Meets the bar', className: 'border-success-border bg-success-bg text-success-text', Icon: CheckCircle2 },
  failed: { title: 'Does not meet the bar', className: 'border-danger-border bg-danger-bg text-danger-text', Icon: XCircle },
  insufficient_evidence: { title: 'Not enough evidence yet', className: 'border-warning-border bg-warning-bg text-warning-text', Icon: CircleHelp },
}

const pct = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`)
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function RateCell({ rate }: { rate: Rate }) {
  if (rate.total === 0) return <span className="text-text-secondary">No data</span>
  return (
    <span className="text-text-primary">
      {pct(rate.rate)} <span className="text-text-secondary">({rate.correct} of {rate.total}; at least {pct(rate.lower)})</span>
    </span>
  )
}

function Stat({ label, rate }: { label: string; rate: Rate }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-bg-primary p-4">
      <span className="text-body-sm text-text-secondary">{label}</span>
      <span className="text-h5 text-text-primary">{pct(rate.rate)}</span>
      <span className="text-body-sm text-text-secondary">{rate.total === 0 ? 'No data yet' : `${rate.correct} of ${rate.total}; 95% sure of at least ${pct(rate.lower)}`}</span>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-bg-primary p-6" aria-label={title}>
      <div className="flex flex-col gap-1">
        <h2 className="text-h5 text-text-primary">{title}</h2>
        {hint && <p className="text-body-sm text-text-secondary">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-body-sm">
        <thead>
          <tr className="border-b border-border text-text-secondary">
            {head.map((label) => (
              <th key={label} className="py-2 pr-4 font-medium">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, index) => (
            <tr key={index} className="border-b border-border last:border-0">
              {cells.map((cell, cellIndex) => (
                <td key={cellIndex} className="py-2 pr-4 text-text-primary">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** How accurate this source's output has been, from what its reviewers accepted, corrected and rejected. */
export function EvaluationTab({ source }: { source: SourceDetail }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [period, setPeriod] = useState<(typeof PERIODS)[number]['value']>('all')
  const [running, setRunning] = useState(false)
  const [basis, setBasis] = useState<EvalBasis>('synthetic')
  const days = PERIODS.find((entry) => entry.value === period)?.days ?? null

  const query = useQuery({
    queryKey: queryKeys.sourceEvaluation(source.id, days),
    queryFn: () => fetchEvaluation(source.id, days),
    staleTime: 0,
    retry: false,
  })

  async function run(note: string | undefined) {
    const result = await runSourceEvaluation(source.id, basis, note)
    await queryClient.invalidateQueries({ queryKey: queryKeys.source(source.id) })
    await queryClient.invalidateQueries({ queryKey: queryKeys.sources })
    await queryClient.invalidateQueries({ queryKey: ['source-evaluation', source.id] })
    toast({
      title: result.verdict === 'passed' ? 'Evaluation passed' : 'Evaluation did not meet the bar',
      description: result.verdict === 'passed' ? `Recorded as ${basis} data. Auto-commit can now be enabled.` : 'Auto-commit stays off. See which criteria were missed.',
      tone: result.verdict === 'passed' ? 'success' : 'danger',
    })
  }

  if (query.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading the evaluation" className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />

  const view: EvaluationView = query.data
  const verdict = VERDICT[view.verdict]
  const VerdictIcon = verdict.Icon
  const empty = view.evidence.records === 0

  return (
    <div className="flex flex-col gap-6">
      <div className={`flex flex-wrap items-start justify-between gap-4 rounded-lg border p-4 ${verdict.className}`} role="status">
        <div className="flex items-start gap-3">
          <VerdictIcon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="flex flex-col gap-1">
            <span className="text-h5">{verdict.title}</span>
            <span className="text-body-sm">
              Based on {view.evidence.records} reviewed record{view.evidence.records === 1 ? '' : 's'} and {view.evidence.fields} fields.
              {view.last_run && ` Last run ${dateFormatter.format(new Date(view.last_run.ran_at))}: ${view.last_run.passed ? 'passed' : 'did not pass'}${view.last_run.basis ? ` on ${view.last_run.basis} data` : ''}.`}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Period"
            value={period}
            onChange={(event) => setPeriod(event.target.value as typeof period)}
            className="rounded-md border border-border bg-bg-primary px-2 py-2 text-body-sm text-text-primary"
          >
            {PERIODS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
          <RoleGate allow={['admin']}>
            <button type="button" className="btn-primary" onClick={() => setRunning(true)} disabled={empty}>
              <ClipboardCheck aria-hidden="true" className="h-4 w-4" />
              Run evaluation
            </button>
          </RoleGate>
        </div>
      </div>

      {view.stale && (
        <p className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-body-sm text-warning-text" role="alert">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          The last pass covered a different model than the one in use now ({view.model_id ?? 'unknown'}). Review records with the current model and run the evaluation again before enabling auto-commit.
        </p>
      )}

      {empty ? (
        <Section title="Nothing to evaluate yet">
          <p className="text-body-sm text-text-secondary">
            This evaluation uses what reviewers do with the source&apos;s records: every accepted, corrected or rejected field is a measurement. Review at least {view.bar.minRecords} records ({view.bar.minFields} fields) in the Review queue and this page fills in.
          </p>
        </Section>
      ) : (
        <>
          <Section title="The bar" hint="All of these must hold. Accuracy is judged by its lower bound (we must be 95% sure), so small samples cannot pass by luck.">
            <ul className="flex flex-col gap-2">
              {view.criteria.map((entry) => (
                <li key={entry.id} className="flex items-start gap-2 text-body-sm">
                  {entry.met === true ? (
                    <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success-text" />
                  ) : entry.met === false ? (
                    <XCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-danger-text" />
                  ) : (
                    <CircleHelp aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
                  )}
                  <span className="text-text-primary">
                    {entry.label}: <span className="text-text-secondary">{entry.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Stat label="All fields" rate={view.accuracy.overall} />
            <Stat label="Medication, allergy and lab fields" rate={view.accuracy.high_risk} />
            <Stat label="Other fields" rate={view.accuracy.other} />
            <Stat label="Codes left unchanged" rate={view.accuracy.code} />
            <Stat label="Values stated in the document" rate={view.accuracy.stated} />
            <Stat label="Values the model inferred" rate={view.accuracy.inferred} />
          </div>

          <Section title="Does a high score mean it is right?" hint="Fields grouped by their score at the time. If the accuracy is clearly below the score, the scores are too optimistic.">
            {view.calibration.length === 0 ? (
              <p className="text-body-sm text-text-secondary">No scored fields yet.</p>
            ) : (
              <Table
                head={['Score range', 'Fields', 'Average score', 'Actually right']}
                rows={view.calibration.map((row) => [row.bucket, row.fields, pct(row.mean_score), pct(row.accuracy)])}
              />
            )}
          </Section>

          <Section title="Which threshold would be safe?" hint="If only resources scoring at least this much were committed without a reviewer, this is how often they would have been right.">
            {view.suggested_thresholds.length === 0 ? (
              <p className="text-body-sm text-text-secondary">No scored resources yet.</p>
            ) : (
              <>
                <Table
                  head={['Resource type', 'Suggested threshold', 'Why']}
                  rows={view.suggested_thresholds.map((row) => [row.resource_type, row.threshold === null ? 'None yet' : row.threshold.toFixed(2), row.reason])}
                />
                <details>
                  <summary className="cursor-pointer text-body-sm text-brand">All thresholds tried</summary>
                  <div className="mt-2">
                    <Table
                      head={['Resource type', 'At least', 'Resources', 'Right with no change']}
                      rows={view.threshold_curve.map((row) => [row.resource_type, row.threshold.toFixed(2), row.resources, <RateCell key="rate" rate={row.rate} />])}
                    />
                  </div>
                </details>
              </>
            )}
          </Section>

          <Section title="Accuracy by kind of value">
            <div className="grid gap-6 lg:grid-cols-2">
              <Table head={['Resource type', 'Right']} rows={view.by_resource_type.map((row) => [row.resource_type, <RateCell key="rate" rate={row.rate} />])} />
              <Table head={['Field (weakest first)', 'Right']} rows={view.by_field.slice(0, 12).map((row) => [row.field, <RateCell key="rate" rate={row.rate} />])} />
            </div>
          </Section>

          <Section title="How the reviewing was done" hint="Evidence is only as good as the review behind it. Records accepted in full, quickly, may not have been checked closely.">
            <dl className="grid gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-0.5">
                <dt className="text-body-sm text-text-secondary">Records accepted in full</dt>
                <dd className="text-body-lg text-text-primary">{view.evidence.records_all_accepted} of {view.evidence.records}</dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-body-sm text-text-secondary">Median time to decide</dt>
                <dd className="text-body-lg text-text-primary">{view.evidence.median_decision_seconds === null ? 'n/a' : `${Math.round(view.evidence.median_decision_seconds)} s`}</dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-body-sm text-text-secondary">Audit holdback sample (right)</dt>
                <dd className="text-body-lg text-text-primary">{view.holdback ? <RateCell rate={view.holdback} /> : 'None yet: needs auto-commit to be on'}</dd>
              </div>
            </dl>
          </Section>
        </>
      )}

      <ConfirmDialog
        open={running}
        onOpenChange={setRunning}
        title="Run the evaluation?"
        description="This judges the source on every reviewed record, stores the result, and sets its evaluation status. A pass is what allows auto-commit to be enabled; a fail switches auto-commit off if it was on."
        confirmLabel="Run evaluation"
        requireReason={{ min: 3, label: 'Note (why now?)' }}
        extra={
          <label className="flex flex-col gap-1 text-body-sm text-text-primary">
            What kind of documents were reviewed?
            <select
              value={basis}
              onChange={(event) => setBasis(event.target.value as EvalBasis)}
              className="rounded-md border border-border bg-bg-primary px-2 py-2 text-body-sm text-text-primary"
            >
              <option value="synthetic">Synthetic (made-up) documents</option>
              <option value="real">Real patient documents</option>
            </select>
            <span className="text-text-secondary">A pass is always shown with this label.</span>
          </label>
        }
        onConfirm={run}
      />
    </div>
  )
}
