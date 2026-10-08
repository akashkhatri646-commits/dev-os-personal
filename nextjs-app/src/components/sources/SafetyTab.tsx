'use client'

import { useQueryClient } from '@tanstack/react-query'
import { PauseCircle, PlayCircle, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { RoleGate } from '@/components/layout/RoleGate'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { EvalStatusBadge, SourceStatusBadge } from '@/components/sources/SourceBadges'
import { useToast } from '@/components/ui/Toaster'
import { queryKeys } from '@/lib/api/queryKeys'
import { enableAutoCommit, pauseSource, resumeSource } from '@/lib/api/sources'
import type { SourceDetail } from '@/types/sources'

type Action = 'enable' | 'pause' | 'resume'

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const COPY: Record<Action, { title: string; description: string; confirm: string; reasonLabel: string; destructive: boolean; toast: string }> = {
  enable: {
    title: 'Enable auto-commit?',
    description:
      'Records that clear every check and score above their thresholds will be committed without human review. A random share is still held back for audit.',
    confirm: 'Enable auto-commit',
    reasonLabel: 'Why is this source ready?',
    destructive: false,
    toast: 'Auto-commit enabled',
  },
  pause: {
    title: 'Pause auto-commit?',
    description:
      'Every new record from this source will go to manual review until an admin resumes it. Records already in the queue are not affected.',
    confirm: 'Pause auto-commit',
    reasonLabel: 'Reason for pausing',
    destructive: true,
    toast: 'Auto-commit paused',
  },
  resume: {
    title: 'Resume auto-commit?',
    description: 'The source will auto-commit again for records that pass all checks.',
    confirm: 'Resume auto-commit',
    reasonLabel: 'Why is it safe to resume?',
    destructive: false,
    toast: 'Auto-commit resumed',
  },
}

export function SafetyTab({ source }: { source: SourceDetail }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [action, setAction] = useState<Action | null>(null)

  const evalPassed = source.eval_status === 'passed'

  async function confirm(reason: string | undefined) {
    if (!action || !reason) return
    if (action === 'enable') await enableAutoCommit(source.id, reason)
    else if (action === 'pause') await pauseSource(source.id, reason)
    else await resumeSource(source.id, reason)
    await queryClient.invalidateQueries({ queryKey: queryKeys.source(source.id) })
    await queryClient.invalidateQueries({ queryKey: queryKeys.sources })
    toast({ title: COPY[action].toast, description: source.name, tone: 'success' })
  }

  const copy = action ? COPY[action] : null

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4 rounded-lg border border-border bg-bg-primary p-6" aria-labelledby="safety-status">
        <h2 id="safety-status" className="text-h5 text-text-primary">
          Auto-commit status
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <SourceStatusBadge status={source.status} />
          <EvalStatusBadge status={source.eval_status} />
          <span className="text-body-sm text-text-secondary">Audit holdback: {source.holdback_pct}% of would-be auto-commits</span>
        </div>

        {source.status === 'paused' && source.pause_reason && (
          <p className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-body-sm text-warning-text">
            Paused: {source.pause_reason}
          </p>
        )}
        {source.flagged_poor && (
          <p className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-body-sm text-warning-text">
            Reviewers flagged this source as consistently poor. Review quality before enabling or resuming.
          </p>
        )}

        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-0.5">
            <dt className="text-body-lg text-text-primary">Onboarding evaluation</dt>
            <dd className="text-body-sm text-text-secondary">
              {source.latest_eval
                ? `${source.latest_eval.passed ? 'Passed' : 'Failed'} on ${dateFormatter.format(new Date(source.latest_eval.ran_at))} (${source.latest_eval.sample_count} labeled records)`
                : 'No evaluation has run yet.'}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-body-lg text-text-primary">Requirement</dt>
            <dd className="text-body-sm text-text-secondary">
              Auto-commit needs at least 50 clinician-labeled records for this source to pass the evaluation. The
              evaluation runs from the evaluation tooling, which arrives with the evaluation feature.
            </dd>
          </div>
        </dl>
      </section>

      <RoleGate
        allow={['admin']}
        fallback={<p className="text-body-sm text-text-secondary">Only admins can change auto-commit settings.</p>}
      >
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-bg-primary p-6" aria-labelledby="safety-actions">
          <h2 id="safety-actions" className="text-h5 text-text-primary">
            Actions
          </h2>
          <div className="flex flex-wrap gap-2">
            {source.status === 'manual_only' && (
              <button
                type="button"
                className="btn-primary"
                disabled={!evalPassed}
                title={evalPassed ? undefined : 'The onboarding evaluation must pass first'}
                onClick={() => setAction('enable')}
              >
                <ShieldCheck aria-hidden="true" className="h-4 w-4" />
                Enable auto-commit
              </button>
            )}
            {source.status === 'auto_commit' && (
              <button type="button" className="btn-danger" onClick={() => setAction('pause')}>
                <PauseCircle aria-hidden="true" className="h-4 w-4" />
                Pause auto-commit
              </button>
            )}
            {source.status === 'paused' && (
              <button
                type="button"
                className="btn-primary"
                disabled={!evalPassed}
                title={evalPassed ? undefined : 'The onboarding evaluation must pass first'}
                onClick={() => setAction('resume')}
              >
                <PlayCircle aria-hidden="true" className="h-4 w-4" />
                Resume auto-commit
              </button>
            )}
            {source.status === 'manual_only' && (
              <button type="button" className="btn-secondary" onClick={() => setAction('pause')}>
                <PauseCircle aria-hidden="true" className="h-4 w-4" />
                Mark as paused
              </button>
            )}
          </div>
          {!evalPassed && source.status !== 'auto_commit' && (
            <p className="text-body-sm text-text-secondary">
              Enabling and resuming are unavailable until the onboarding evaluation passes.
            </p>
          )}
        </section>
      </RoleGate>

      {copy && (
        <ConfirmDialog
          open={action !== null}
          onOpenChange={(open) => {
            if (!open) setAction(null)
          }}
          title={copy.title}
          description={copy.description}
          confirmLabel={copy.confirm}
          destructive={copy.destructive}
          requireReason={{ min: 5, label: copy.reasonLabel }}
          onConfirm={confirm}
        />
      )}
    </div>
  )
}
