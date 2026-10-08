'use client'

import { Check, Pencil, Quote, X } from 'lucide-react'
import { ConfidenceBar } from '@/components/shared/ConfidenceBar'
import { FieldEditor } from '@/components/review/FieldEditor'
import type { DraftDecision } from '@/lib/review/draft'
import { concernLabel } from '@/lib/review/labels'
import { cn } from '@/lib/utils/cn'
import type { WorkspaceField } from '@/types/review'

interface FieldRowProps {
  field: WorkspaceField
  resourceType: string
  threshold: number | null
  decision: DraftDecision | undefined
  /** A problem with this field's decision, from this screen or the server. */
  issue?: string
  active: boolean
  editing: boolean
  readOnly: boolean
  onActivate: () => void
  onDecide: (decision: DraftDecision | null) => void
  onEdit: (editing: boolean) => void
  onShowSource: () => void
}

const DECISION_BADGE = {
  accept: { label: 'Accepted', className: 'badge-success' },
  correct: { label: 'Corrected', className: 'badge-info' },
  reject: { label: 'Rejected', className: 'badge-danger' },
} as const

function valueText(field: WorkspaceField): string {
  return field.found && field.value !== null ? String(field.value) : 'Not found in the document'
}

export function FieldRow({ field, resourceType, threshold, decision, issue, active, editing, readOnly, onActivate, onDecide, onEdit, onShowSource }: FieldRowProps) {
  const pending = field.needs_decision && !decision
  const badge = decision ? DECISION_BADGE[decision.action] : null
  const corrected = decision?.action === 'correct'

  return (
    <div
      data-field-row
      data-field-key={field.field_key}
      tabIndex={0}
      onFocus={onActivate}
      onClick={onActivate}
      aria-label={`${field.label}: ${valueText(field)}${pending ? ', needs your decision' : ''}`}
      className={cn(
        'flex flex-col gap-2 rounded-md border bg-bg-primary p-3 transition-colors duration-fast',
        active ? 'border-border-brand' : 'border-border',
        issue && 'border-danger-solid',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-body-lg text-text-primary">{field.label}</span>
        <div className="flex flex-wrap items-center gap-1">
          {field.required && <span className="badge-neutral">Required</span>}
          {pending && <span className="badge-warning">Needs your decision</span>}
          {badge && <span className={badge.className}>{badge.label}</span>}
        </div>
      </div>

      <p className={cn('break-words text-body-lg', field.found ? 'text-text-primary' : 'italic text-text-secondary', corrected && 'line-through decoration-text-secondary')}>
        {valueText(field)}
      </p>
      {corrected && (
        <p className="break-words text-body-lg text-text-primary">
          {decision?.value ?? valueText(field)}
          {decision?.code && <span className="ml-2 font-mono text-body-sm text-text-secondary">{decision.code.code}</span>}
        </p>
      )}

      {field.coding && !corrected && (
        <p className="text-body-sm text-text-secondary">
          Code {field.coding.code} · {field.coding.display} ({Math.round(field.coding.match_confidence * 100)}% match)
        </p>
      )}

      {field.span?.quote && (
        <button type="button" onClick={onShowSource} className="inline-flex items-start gap-1 text-left text-body-sm text-text-secondary hover:text-text-primary">
          <Quote aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="line-clamp-2">“{field.span.quote}”</span>
        </button>
      )}
      {field.span?.manual && <span className="text-body-sm text-text-secondary">Supplied by a reviewer</span>}

      <ConfidenceBar score={field.score} {...(threshold !== null ? { threshold } : {})} />

      <div className="flex flex-wrap gap-1">
        {field.basis === 'inferred' && <span className="badge-warning">Inferred, not stated</span>}
        {field.concerns
          .filter((concern) => concern !== 'inferred')
          .map((concern) => (
            <span key={concern} className="badge-warning">
              {concernLabel(concern)}
            </span>
          ))}
      </div>

      {issue && (
        <p role="alert" className="text-body-sm text-danger-text">
          {issue}
        </p>
      )}

      {editing ? (
        <FieldEditor
          field={field}
          resourceType={resourceType}
          {...(decision?.action === 'correct' ? { initial: decision } : {})}
          onSave={(next) => {
            onDecide(next)
            onEdit(false)
          }}
          onCancel={() => onEdit(false)}
        />
      ) : (
        !readOnly && (
          <div className="flex flex-wrap gap-2" role="group" aria-label={`Decision for ${field.label}`}>
            <button type="button" className="btn-secondary px-3 py-1" aria-pressed={decision?.action === 'accept'} onClick={() => onDecide(decision?.action === 'accept' ? null : { action: 'accept' })}>
              <Check aria-hidden="true" className="h-4 w-4" />
              Accept <kbd className="text-body-sm text-text-secondary">A</kbd>
            </button>
            <button type="button" className="btn-secondary px-3 py-1" aria-pressed={decision?.action === 'correct'} onClick={() => onEdit(true)}>
              <Pencil aria-hidden="true" className="h-4 w-4" />
              Correct <kbd className="text-body-sm text-text-secondary">C</kbd>
            </button>
            {!field.required && field.found && (
              <button type="button" className="btn-secondary px-3 py-1" aria-pressed={decision?.action === 'reject'} onClick={() => onDecide(decision?.action === 'reject' ? null : { action: 'reject' })}>
                <X aria-hidden="true" className="h-4 w-4" />
                Reject <kbd className="text-body-sm text-text-secondary">R</kbd>
              </button>
            )}
          </div>
        )
      )}
    </div>
  )
}
