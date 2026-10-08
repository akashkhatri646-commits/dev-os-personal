'use client'

import { CheckCircle2, Loader2 } from 'lucide-react'
import type { DecisionCounts } from '@/lib/review/draft'

interface SubmitBarProps {
  counts: DecisionCounts
  canApprove: boolean
  /** Why approval is not possible yet, shown beside the button. */
  blockedReason: string | null
  submitting: boolean
  readOnly: boolean
  canRequestReupload: boolean
  onApprove: () => void
  onReject: () => void
  onRelease: () => void
  onRequestReupload: () => void
}

/** Sticky decision summary and the actions that end a review. */
export function SubmitBar({ counts, canApprove, blockedReason, submitting, readOnly, canRequestReupload, onApprove, onReject, onRelease, onRequestReupload }: SubmitBarProps) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-bg-primary px-4 py-3 sm:-mx-6 sm:px-6">
      <p className="text-body-sm text-text-secondary" aria-live="polite">
        <span className="text-text-primary">{counts.accepted} accepted</span> · {counts.corrected} corrected · {counts.rejected} rejected ·{' '}
        <span className={counts.pending > 0 ? 'text-warning-text' : undefined}>{counts.pending} to decide</span>
        {blockedReason && !readOnly && <span className="ml-2">{blockedReason}</span>}
      </p>
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={onRelease} disabled={submitting}>
            Release task
          </button>
          {canRequestReupload && (
            <button type="button" className="btn-secondary" onClick={onRequestReupload} disabled={submitting}>
              Ask for a new copy
            </button>
          )}
          <button type="button" className="btn-danger" onClick={onReject} disabled={submitting}>
            Reject record
          </button>
          <button type="button" className="btn-primary" onClick={onApprove} disabled={!canApprove || submitting}>
            {submitting ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <CheckCircle2 aria-hidden="true" className="h-4 w-4" />}
            Approve and commit
          </button>
        </div>
      )}
    </div>
  )
}
