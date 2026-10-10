'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, History, Loader2, OctagonAlert, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { AuditTimeline } from '@/components/audit/AuditTimeline'
import { RoleGate } from '@/components/layout/RoleGate'
import { PipelineTimeline } from '@/components/records/PipelineTimeline'
import { RerunControl } from '@/components/records/RerunControl'
import { ReportErrorDialog } from '@/components/records/ReportErrorDialog'
import { ConsentTab, DecisionTab, FhirTab, FieldsTab, ProvenanceTab, SourceTab } from '@/components/records/RecordTabs'
import { ErrorState } from '@/components/shared/ErrorState'
import { PageHeader } from '@/components/shared/PageHeader'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton'
import { TabPanel, Tabs } from '@/components/ui/Tabs'
import { useToast } from '@/components/ui/Toaster'
import { ApiError } from '@/lib/api/errors'
import { fetchRecordDetail, fetchRecordTrace, kickRecord, retryRecord } from '@/lib/api/ingestions'
import { queryKeys } from '@/lib/api/queryKeys'
import { isRetryable, reasonLabel } from '@/lib/records/reasons'
import type { RecordStatus } from '@/types/domain'

const TABS = [
  { id: 'fields', label: 'Fields' },
  { id: 'fhir', label: 'FHIR' },
  { id: 'decision', label: 'Decision' },
  { id: 'consent', label: 'Consent' },
  { id: 'provenance', label: 'Provenance' },
  { id: 'source', label: 'Source' },
] as const
type TabId = (typeof TABS)[number]['id']

/** A record that has not moved for this long is waiting on the worker: the page asks for a pass. */
const KICK_AFTER_MS = 12_000
const KICK_CHECK_MS = 4_000

const PROCESSING: readonly RecordStatus[] = ['received', 'consent_check', 'normalizing', 'extracting', 'mapping', 'validating', 'scoring', 'routing']
const DOC_LABEL = { discharge_summary: 'Discharge summary', lab_report: 'Lab report', other: 'Other' } as const
const KIND_LABEL = { pdf: 'PDF', image: 'Image', hl7v2: 'HL7v2', text: 'Text' } as const
const dateFormatter = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })

function formatLatency(ms: number | null): string {
  if (ms === null) return 'Not finished'
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`
  return `${(ms / 60_000).toFixed(1)} min`
}

export function RecordDetailView({ recordId }: { recordId: string }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [tab, setTab] = useState<TabId>('fields')
  const [reconstructing, setReconstructing] = useState(false)
  const [reporting, setReporting] = useState(false)

  const detail = useQuery({
    queryKey: queryKeys.recordDetail(recordId),
    queryFn: () => fetchRecordDetail(recordId),
    retry: false,
    // A record still moving through the pipeline is refreshed until it settles.
    refetchInterval: (query) => (query.state.data && PROCESSING.includes(query.state.data.status) ? 5000 : false),
  })
  const status = detail.data?.status
  const trace = useQuery({
    queryKey: queryKeys.recordTrace(recordId),
    queryFn: () => fetchRecordTrace(recordId),
    enabled: detail.isSuccess,
    retry: false,
    // Re-read when the record changes state (for example once it is committed).
    staleTime: 0,
    // Fields, scores and resources appear as the stages finish.
    refetchInterval: status && PROCESSING.includes(status) ? 5000 : false,
  })

  // Safety net: if a record in progress has not moved for a while, ask the worker to run now. The server only acts
  // when the record has a job that is due and idle, so this is harmless when the usual hand-over is working.
  const progressKey = `${status ?? ''}|${detail.data?.events.length ?? 0}`
  const lastProgress = useRef({ key: '', at: Date.now() })
  if (lastProgress.current.key !== progressKey) lastProgress.current = { key: progressKey, at: Date.now() }
  useEffect(() => {
    if (!status || !PROCESSING.includes(status)) return undefined
    const timer = setInterval(() => {
      if (Date.now() - lastProgress.current.at < KICK_AFTER_MS) return
      lastProgress.current = { ...lastProgress.current, at: Date.now() }
      void kickRecord(recordId)
        .then(async () => {
          await queryClient.invalidateQueries({ queryKey: queryKeys.recordDetail(recordId) })
          await queryClient.invalidateQueries({ queryKey: queryKeys.recordTrace(recordId) })
        })
        .catch(() => undefined)
    }, KICK_CHECK_MS)
    return () => clearInterval(timer)
  }, [status, recordId, queryClient])

  const retry = useMutation({
    mutationFn: () => retryRecord(recordId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.recordDetail(recordId) })
      toast({ title: 'Retry queued', description: 'The record will be processed again shortly.', tone: 'success' })
    },
    onError: (error) => toast({ title: 'Could not retry', description: error instanceof ApiError ? error.message : 'Try again shortly.', tone: 'danger' }),
  })

  if (detail.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading the record">
        <Skeleton className="h-10 w-72" />
        <SkeletonText lines={4} />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4">
        <Link href="/records" className="inline-flex w-fit items-center gap-1 text-body-sm text-text-secondary hover:text-text-primary">
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          Back to records
        </Link>
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    )
  }

  const record = detail.data
  const reason = reasonLabel(record.status_reason)

  return (
    <div className="flex flex-col gap-6">
      <Link href="/records" className="inline-flex w-fit items-center gap-1 text-body-sm text-text-secondary hover:text-text-primary">
        <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        Back to records
      </Link>

      <PageHeader
        title={`Record ${record.id.slice(0, 8)}`}
        description={`${record.source_name ?? 'Unknown source'} · ${DOC_LABEL[record.doc_type]} · ${KIND_LABEL[record.input_kind]}`}
        actions={
          <>
            {isRetryable(record.status, record.status_reason) && (
              <RoleGate allow={['integration_engineer', 'admin']}>
                <button type="button" className="btn-secondary" onClick={() => retry.mutate()} disabled={retry.isPending}>
                  {retry.isPending ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="h-4 w-4" />}
                  Retry
                </button>
              </RoleGate>
            )}
            {(record.status === 'needs_review' || record.status === 'failed') && (
              <RoleGate allow={['admin']}>
                <RerunControl recordId={record.id} />
              </RoleGate>
            )}
            {record.status === 'needs_review' && (
              <RoleGate allow={['reviewer', 'admin']}>
                <Link href="/review" className="btn-secondary">Go to the review queue</Link>
              </RoleGate>
            )}
            {(record.status === 'committed' || record.status === 'auto_committed') && (
              <RoleGate allow={['reviewer', 'admin']}>
                <button type="button" className="btn-secondary" onClick={() => setReporting(true)}>
                  <OctagonAlert aria-hidden="true" className="h-4 w-4" />
                  Report an error
                </button>
              </RoleGate>
            )}
            <RoleGate allow={['admin']}>
              <button type="button" className="btn-secondary" onClick={() => setReconstructing(true)}>
                <History aria-hidden="true" className="h-4 w-4" />
                Why this outcome
              </button>
            </RoleGate>
          </>
        }
      />

      <section className="flex flex-col gap-3 rounded-lg border border-border bg-bg-primary p-4" aria-label="Summary">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={record.status} reason={record.status_reason} />
          {reason && <span className="text-body-sm text-text-secondary">{reason}</span>}
        </div>
        <dl className="grid gap-3 text-body-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-text-secondary">Received</dt><dd className="text-text-primary">{dateFormatter.format(new Date(record.created_at))} UTC</dd></div>
          <div><dt className="text-text-secondary">Completed</dt><dd className="text-text-primary">{record.completed_at ? `${dateFormatter.format(new Date(record.completed_at))} UTC` : 'Not finished'}</dd></div>
          <div><dt className="text-text-secondary">Time to finish</dt><dd className="text-text-primary">{formatLatency(record.latency_ms)}</dd></div>
          <div><dt className="text-text-secondary">Model cost</dt><dd className="text-text-primary">${record.cost_usd.toFixed(4)}</dd></div>
        </dl>
      </section>

      <PipelineTimeline status={record.status} events={record.events} />

      <div className="flex flex-col gap-4">
        <Tabs tabs={TABS} active={tab} onChange={(id) => setTab(id as TabId)} ariaLabel="Record sections" />
        {tab === 'consent' || tab === 'source' ? (
          <>
            <TabPanel id="consent" active={tab}><ConsentTab detail={record} /></TabPanel>
            <TabPanel id="source" active={tab}><SourceTab detail={record} /></TabPanel>
          </>
        ) : trace.isPending ? (
          <div aria-busy="true"><SkeletonText lines={6} /></div>
        ) : trace.isError ? (
          <ErrorState error={trace.error} onRetry={() => void trace.refetch()} />
        ) : (
          <>
            <TabPanel id="fields" active={tab}><FieldsTab trace={trace.data} /></TabPanel>
            <TabPanel id="fhir" active={tab}><FhirTab trace={trace.data} /></TabPanel>
            <TabPanel id="decision" active={tab}><DecisionTab trace={trace.data} /></TabPanel>
            <TabPanel id="provenance" active={tab}><ProvenanceTab trace={trace.data} /></TabPanel>
          </>
        )}
      </div>

      <details className="rounded-md border border-border bg-bg-surface px-4 py-3">
        <summary className="cursor-pointer text-body-sm text-text-secondary">About these values</summary>
        <p className="mt-2 max-w-3xl text-body-sm text-text-secondary">
          This is an ingestion aid, not a clinical decision system. Values are AI-extracted from the source document and must not be treated as clinically verified.
        </p>
      </details>

      <ReportErrorDialog
        open={reporting}
        onOpenChange={setReporting}
        recordId={recordId}
        resources={trace.data?.fhir ?? []}
        onReported={() => void queryClient.invalidateQueries({ queryKey: queryKeys.recordTrace(recordId) })}
      />
      <AuditTimeline recordId={reconstructing ? recordId : null} onOpenChange={(open) => !open && setReconstructing(false)} />
      <span className="sr-only" aria-live="polite">{status ? `Record status: ${status.replaceAll('_', ' ')}` : ''}</span>
    </div>
  )
}
