'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ResourceCard, type ServerResourceIssue } from '@/components/review/ResourceCard'
import { SourceViewer } from '@/components/review/SourceViewer'
import { SubmitBar } from '@/components/review/SubmitBar'
import { TracePanel } from '@/components/review/TracePanel'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { ErrorState } from '@/components/shared/ErrorState'
import { PageHeader } from '@/components/shared/PageHeader'
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton'
import { Tabs } from '@/components/ui/Tabs'
import { useToast } from '@/components/ui/Toaster'
import { ApiError } from '@/lib/api/errors'
import { queryKeys } from '@/lib/api/queryKeys'
import {
  claimReviewTask,
  fetchReviewWorkspace,
  heartbeatReviewTask,
  releaseReviewTask,
  requestReviewReupload,
  submitReviewDecisions,
} from '@/lib/api/review'
import {
  allFields,
  canApprove,
  clearDraft,
  countDecisions,
  loadDraft,
  localIssues,
  saveDraft,
  toSubmitDecisions,
  type Draft,
  type DraftDecision,
} from '@/lib/review/draft'
import { cn } from '@/lib/utils/cn'
import type { ReviewWorkspace } from '@/types/review'

const HEARTBEAT_MS = 5 * 60_000
const REFRESH_MS = 4 * 60_000
const TABS = [
  { id: 'source', label: 'Source' },
  { id: 'fields', label: 'Fields' },
  { id: 'trace', label: 'Trace' },
] as const
const REUPLOAD_REASONS = ['low_ocr_quality', 'unreadable_document', 'language_unsupported']

const reasonOf = (error: unknown): string | null =>
  error instanceof ApiError && error.details && typeof error.details === 'object' && 'reason' in error.details ? String((error.details as { reason: unknown }).reason) : null

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))
}

interface ServerIssues {
  byField: Record<string, string>
  resources: Record<string, ServerResourceIssue[]>
  general: string | null
}

const NO_ISSUES: ServerIssues = { byField: {}, resources: {}, general: null }

/** Turns a 422 from the submit call into messages placed on the fields and resources they are about. */
function readIssues(error: ApiError, workspace: ReviewWorkspace): ServerIssues {
  const details = error.details as { issues?: { field_key?: string; message?: string; source_ref?: string; path?: string }[] } | undefined
  const result: ServerIssues = { byField: {}, resources: {}, general: error.message }
  for (const issue of details?.issues ?? []) {
    if (issue.field_key && issue.message) result.byField[issue.field_key] = issue.message
    else if (issue.source_ref && issue.message) {
      const resource = workspace.resources.find((candidate) => candidate.fields.some((field) => field.field_key.startsWith(`${issue.source_ref}.`)))
      if (resource) result.resources[resource.id] = [...(result.resources[resource.id] ?? []), { ...(issue.path ? { path: issue.path } : {}), message: issue.message }]
    }
  }
  return result
}

export function ReviewWorkspaceView({ taskId }: { taskId: string }) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const query = useQuery({
    queryKey: queryKeys.reviewWorkspace(taskId),
    queryFn: () => fetchReviewWorkspace(taskId),
    retry: false,
    refetchOnWindowFocus: false,
    // The document link is short-lived, so the workspace is refreshed before it expires.
    refetchInterval: REFRESH_MS,
  })
  const workspace = query.data

  const [draft, setDraft] = useState<Draft>(() => loadDraft(taskId))
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('fields')
  const [serverIssues, setServerIssues] = useState<ServerIssues>(NO_ISSUES)
  const [lockLost, setLockLost] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [dialog, setDialog] = useState<'reject' | 'reupload' | null>(null)
  const [finished, setFinished] = useState(false)

  useEffect(() => {
    if (!finished) saveDraft(taskId, draft)
  }, [draft, taskId, finished])

  const resources = useMemo(() => workspace?.resources ?? [], [workspace])
  const fields = useMemo(() => allFields(resources), [resources])
  const readOnly = !workspace?.task.held_by_me || lockLost
  const counts = useMemo(() => countDecisions(resources, draft), [resources, draft])
  const problems = useMemo(() => localIssues(resources, draft), [resources, draft])
  const approvable = canApprove(resources, draft)
  const activeField = fields.find((field) => field.field_key === activeKey) ?? null

  // Another reviewer or the server may reveal the hold was lost.
  useEffect(() => {
    if (query.error && reasonOf(query.error) === 'LOCK_LOST') setLockLost(true)
  }, [query.error])

  useEffect(() => {
    if (!workspace?.task.held_by_me || lockLost) return
    const handle = window.setInterval(() => {
      heartbeatReviewTask(taskId).catch((error: unknown) => {
        if (reasonOf(error) === 'LOCK_LOST') setLockLost(true)
      })
    }, HEARTBEAT_MS)
    return () => window.clearInterval(handle)
  }, [taskId, workspace?.task.held_by_me, lockLost])

  useEffect(() => {
    if (Object.keys(draft).length === 0 || finished) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [draft, finished])

  const decide = useCallback((fieldKey: string, decision: DraftDecision | null) => {
    setServerIssues((current) => {
      if (!(fieldKey in current.byField)) return current
      const { [fieldKey]: _removed, ...rest } = current.byField
      return { ...current, byField: rest }
    })
    setDraft((current) => {
      if (decision === null) {
        const { [fieldKey]: _removed, ...rest } = current
        return rest
      }
      return { ...current, [fieldKey]: decision }
    })
    const label = fields.find((field) => field.field_key === fieldKey)?.label ?? fieldKey
    setAnnouncement(decision === null ? `Decision cleared for ${label}` : `${label}: ${decision.action === 'accept' ? 'accepted' : decision.action === 'correct' ? 'corrected' : 'rejected'}`)
  }, [fields])

  const showSource = useCallback(
    (fieldKey: string) => {
      const field = fields.find((entry) => entry.field_key === fieldKey)
      setActiveKey(fieldKey)
      if (field?.span && field.span.page > 0) setPage(field.span.page)
      setTab('source')
    },
    [fields],
  )

  // Keyboard: J/K move between fields, A/C/R decide, [ and ] turn pages.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return
      const key = event.key.toLowerCase()
      if (key === 'j' || key === 'k') {
        const rows = [...document.querySelectorAll<HTMLElement>('[data-field-row]')].filter((row) => row.offsetParent !== null)
        if (rows.length === 0) return
        const current = rows.findIndex((row) => row === document.activeElement || row.contains(document.activeElement))
        const next = key === 'j' ? Math.min(rows.length - 1, current + 1) : Math.max(0, current <= 0 ? 0 : current - 1)
        rows[next]?.focus()
        event.preventDefault()
      } else if (key === '[' || key === ']') {
        const numbers = (workspace?.document.pages ?? []).map((entry) => entry.page)
        const index = numbers.indexOf(page)
        const target = numbers[key === ']' ? index + 1 : index - 1]
        if (target !== undefined) setPage(target)
      } else if (['a', 'c', 'r'].includes(key) && activeKey && !readOnly) {
        const field = fields.find((entry) => entry.field_key === activeKey)
        if (!field) return
        event.preventDefault()
        if (key === 'a') decide(activeKey, draft[activeKey]?.action === 'accept' ? null : { action: 'accept' })
        else if (key === 'c') setEditingKey(activeKey)
        else if (!field.required && field.found) decide(activeKey, draft[activeKey]?.action === 'reject' ? null : { action: 'reject' })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeKey, decide, draft, fields, page, readOnly, workspace?.document.pages])

  function leave(message?: { title: string; description?: string }) {
    setFinished(true)
    clearDraft(taskId)
    void queryClient.invalidateQueries({ queryKey: ['review-tasks'] })
    if (message) toast({ ...message, tone: 'success' })
    router.push('/review')
  }

  function handleSubmitError(error: unknown) {
    if (!(error instanceof ApiError)) {
      toast({ title: 'Could not submit', description: 'Try again.', tone: 'danger' })
      return
    }
    const reason = reasonOf(error)
    if (reason === 'LOCK_LOST') {
      setLockLost(true)
      return
    }
    if (reason === 'CONSENT_NO_LONGER_VALID' || reason === 'TASK_CLOSED') {
      setFinished(true)
      clearDraft(taskId)
      void queryClient.invalidateQueries({ queryKey: ['review-tasks'] })
      toast({ title: reason === 'TASK_CLOSED' ? 'This task is closed' : 'Consent is no longer valid', description: error.message, tone: 'danger' })
      router.push('/review')
      return
    }
    if (error.status === 422 && workspace) {
      setServerIssues(readIssues(error, workspace))
      return
    }
    toast({ title: 'Could not submit', description: error.message, tone: 'danger' })
  }

  const approve = useMutation({
    mutationFn: () => submitReviewDecisions(taskId, { decisions: toSubmitDecisions(resources, draft), overall: 'approve' }),
    onSuccess: () => leave({ title: 'Record committed', description: 'Your decisions were saved as review data.' }),
    onError: handleSubmitError,
  })

  const reclaim = useMutation({
    mutationFn: () => claimReviewTask(taskId),
    onSuccess: async () => {
      setLockLost(false)
      await query.refetch()
    },
    onError: (error) => toast({ title: 'Could not claim the task again', description: error instanceof ApiError ? error.message : 'Try again.', tone: 'danger' }),
  })

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading the review">
        <Skeleton className="h-10 w-72" />
        <div className="grid gap-4 lg:grid-cols-3">
          <SkeletonText lines={10} />
          <SkeletonText lines={10} />
          <SkeletonText lines={6} />
        </div>
      </div>
    )
  }

  if (query.isError || !workspace) {
    const closed = reasonOf(query.error) === 'TASK_CLOSED'
    return (
      <div className="flex flex-col gap-4">
        <Link href="/review" className="inline-flex w-fit items-center gap-1 text-body-sm text-text-secondary hover:text-text-primary">
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          Back to the queue
        </Link>
        <ErrorState error={query.error} {...(closed ? { title: 'This task is closed' } : {})} onRetry={() => void query.refetch()} />
      </div>
    )
  }

  const blockedReason =
    resources.length === 0
      ? 'There is nothing to commit. Reject the record or ask for a new copy.'
      : counts.pending > 0
        ? `${counts.pending} field${counts.pending === 1 ? '' : 's'} still need a decision.`
        : Object.keys(problems).length > 0
          ? 'Fix the highlighted decisions first.'
          : null

  return (
    <div className="flex flex-col gap-4">
      <Link href="/review" className="inline-flex w-fit items-center gap-1 text-body-sm text-text-secondary hover:text-text-primary">
        <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        Back to the queue
      </Link>
      <PageHeader
        title="Review record"
        description={`${workspace.record.source.name} · ${workspace.record.doc_type.replaceAll('_', ' ')}`}
      />

      {lockLost && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning-border bg-warning-bg px-4 py-3 text-body-sm text-warning-text">
          <span className="inline-flex items-center gap-2">
            <TriangleAlert aria-hidden="true" className="h-4 w-4" />
            Your hold on this task ran out. Your decisions are kept on this screen. Claim the task again to continue.
          </span>
          <button type="button" className="btn-secondary px-3 py-1" onClick={() => reclaim.mutate()} disabled={reclaim.isPending}>
            Claim again
          </button>
        </div>
      )}
      {!workspace.task.held_by_me && !lockLost && (
        <p className="rounded-md border border-border bg-bg-surface px-4 py-3 text-body-sm text-text-secondary">
          You are viewing this task without holding it, so decisions are switched off.
        </p>
      )}
      {serverIssues.general && (
        <p role="alert" className="rounded-md border border-danger-border bg-danger-bg px-4 py-3 text-body-sm text-danger-text">
          {serverIssues.general}
        </p>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>

      <div className="lg:hidden">
        <Tabs tabs={TABS} active={tab} onChange={(id) => setTab(id as (typeof TABS)[number]['id'])} ariaLabel="Review sections" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[40fr_35fr_25fr]">
        <section aria-label="Source document" className={cn('min-h-0 lg:sticky lg:top-4 lg:h-[calc(100vh-14rem)]', tab !== 'source' && 'hidden lg:block')}>
          <SourceViewer pages={workspace.document.pages} originalUrl={workspace.document.signed_url} page={page} onPageChange={setPage} span={activeField?.span ?? null} />
        </section>

        <section aria-label="Draft fields" className={cn('flex min-w-0 flex-col gap-4', tab !== 'fields' && 'hidden lg:flex')}>
          {resources.length === 0 ? (
            <p className="rounded-md border border-border bg-bg-surface px-4 py-6 text-center text-body-sm text-text-secondary">
              Nothing was extracted from this document. Check the source, then reject the record
              {REUPLOAD_REASONS.includes(workspace.record.status_reason ?? '') ? ' or ask for a new copy' : ''}.
            </p>
          ) : (
            resources.map((resource) => (
              <ResourceCard
                key={resource.id}
                resource={resource}
                draft={draft}
                issues={{ ...problems, ...serverIssues.byField }}
                resourceIssues={serverIssues.resources[resource.id] ?? []}
                activeKey={activeKey}
                editingKey={editingKey}
                readOnly={readOnly}
                onActivate={setActiveKey}
                onDecide={decide}
                onEdit={setEditingKey}
                onShowSource={showSource}
              />
            ))
          )}
        </section>

        <section aria-label="Trace and decision" className={cn('min-w-0', tab !== 'trace' && 'hidden lg:block')}>
          <TracePanel workspace={workspace} />
        </section>
      </div>

      <SubmitBar
        counts={counts}
        canApprove={approvable && !readOnly}
        blockedReason={blockedReason}
        submitting={approve.isPending}
        readOnly={readOnly}
        canRequestReupload={REUPLOAD_REASONS.includes(workspace.record.status_reason ?? '')}
        onApprove={() => approve.mutate()}
        onReject={() => setDialog('reject')}
        onRelease={() => {
          releaseReviewTask(taskId)
            .then(() => leave({ title: 'Task released' }))
            .catch((error: unknown) => toast({ title: 'Could not release the task', description: error instanceof ApiError ? error.message : 'Try again.', tone: 'danger' }))
        }}
        onRequestReupload={() => setDialog('reupload')}
      />

      <ConfirmDialog
        open={dialog === 'reject'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Reject this record?"
        description="Nothing is committed. Every field is stored as rejected so the decision can be audited."
        confirmLabel="Reject record"
        destructive
        requireReason={{ min: 3, label: 'Why is it being rejected?' }}
        onConfirm={async (reason) => {
          await submitReviewDecisions(taskId, { decisions: [], overall: 'reject_record', ...(reason ? { note: reason } : {}) }).catch((error: unknown) => {
            handleSubmitError(error)
            throw error
          })
          leave({ title: 'Record rejected' })
        }}
      />
      <ConfirmDialog
        open={dialog === 'reupload'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Ask for a new copy?"
        description="The record is closed and the provider should send a clearer or corrected copy."
        confirmLabel="Ask for a new copy"
        requireReason={{ min: 3, label: 'What is wrong with this copy?' }}
        onConfirm={async (reason) => {
          await requestReviewReupload(taskId, reason ?? '')
          leave({ title: 'New copy requested' })
        }}
      />
    </div>
  )
}
