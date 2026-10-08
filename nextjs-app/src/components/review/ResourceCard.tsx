'use client'

import { CheckCircle2, TriangleAlert } from 'lucide-react'
import { FieldRow } from '@/components/review/FieldRow'
import { ConfidenceBar } from '@/components/shared/ConfidenceBar'
import type { Draft, DraftDecision } from '@/lib/review/draft'
import { RESOURCE_LABELS } from '@/lib/review/labels'
import type { WorkspaceResource } from '@/types/review'

export interface ServerResourceIssue {
  source_ref?: string
  path?: string
  message: string
}

interface ResourceCardProps {
  resource: WorkspaceResource
  draft: Draft
  issues: Record<string, string>
  resourceIssues: readonly ServerResourceIssue[]
  activeKey: string | null
  editingKey: string | null
  readOnly: boolean
  onActivate: (fieldKey: string) => void
  onDecide: (fieldKey: string, decision: DraftDecision | null) => void
  onEdit: (fieldKey: string | null) => void
  onShowSource: (fieldKey: string) => void
}

export function ResourceCard({ resource, draft, issues, resourceIssues, activeKey, editingKey, readOnly, onActivate, onDecide, onEdit, onShowSource }: ResourceCardProps) {
  const needing = resource.fields.filter((field) => field.needs_decision)
  const others = resource.fields.filter((field) => !field.needs_decision)
  const pendingCount = needing.filter((field) => !draft[field.field_key]).length
  const label = RESOURCE_LABELS[resource.resource_type] ?? resource.resource_type
  const valid = resource.validation_status === 'pass'

  const row = (field: WorkspaceResource['fields'][number]) => (
    <FieldRow
      key={field.field_key}
      field={field}
      resourceType={resource.resource_type}
      threshold={resource.threshold}
      decision={draft[field.field_key]}
      {...(issues[field.field_key] ? { issue: issues[field.field_key] } : {})}
      active={activeKey === field.field_key}
      editing={editingKey === field.field_key}
      readOnly={readOnly}
      onActivate={() => onActivate(field.field_key)}
      onDecide={(decision) => onDecide(field.field_key, decision)}
      onEdit={(editing) => onEdit(editing ? field.field_key : null)}
      onShowSource={() => onShowSource(field.field_key)}
    />
  )

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-bg-surface p-4" aria-label={label}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-body-lg text-text-primary">{label}</h3>
        <span className={valid ? 'badge-success' : 'badge-warning'}>
          {valid ? <CheckCircle2 aria-hidden="true" className="h-3 w-3" /> : <TriangleAlert aria-hidden="true" className="h-3 w-3" />}
          {valid ? 'Valid' : resource.validation_status === 'pending' ? 'Not checked yet' : 'Failed checks'}
        </span>
      </div>
      {resource.score !== null && <ConfidenceBar score={resource.score} {...(resource.threshold !== null ? { threshold: resource.threshold } : {})} />}

      {resourceIssues.length > 0 && (
        <ul role="alert" className="flex flex-col gap-1 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-body-sm text-danger-text">
          {resourceIssues.map((issue, index) => (
            <li key={index}>
              {issue.path ? `${issue.path}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      {needing.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-body-sm font-medium text-warning-text">
            Needs your decision ({pendingCount} of {needing.length} left)
          </h4>
          {needing.map(row)}
        </div>
      )}
      {others.length > 0 && (
        <details className="flex flex-col gap-2">
          <summary className="cursor-pointer text-body-sm text-text-secondary">Accepted unless you change them ({others.length})</summary>
          <div className="mt-2 flex flex-col gap-2">{others.map(row)}</div>
        </details>
      )}
    </section>
  )
}
