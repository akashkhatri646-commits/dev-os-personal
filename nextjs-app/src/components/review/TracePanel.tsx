'use client'

import { reasonLabel } from '@/lib/records/reasons'
import { RESOURCE_LABELS } from '@/lib/review/labels'
import { ConfidenceBar } from '@/components/shared/ConfidenceBar'
import type { ReviewWorkspace } from '@/types/review'

/** Why the record is here and how it scored: the routing decision, thresholds, validation issues and consent. */
export function TracePanel({ workspace }: { workspace: ReviewWorkspace }) {
  const { decision, record, consent } = workspace
  const issues = workspace.resources.flatMap((resource) =>
    resource.validation_issues.filter((issue) => issue.severity === 'error').map((issue) => ({ ...issue, resource: RESOURCE_LABELS[resource.resource_type] ?? resource.resource_type })),
  )

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2" aria-label="Why this record needs review">
        <h3 className="text-body-lg text-text-primary">Why it is here</h3>
        <div className="flex flex-wrap gap-1">
          {(decision?.reasons ?? []).map((reason) => (
            <span key={reason} className="badge-warning">
              {reasonLabel(reason)}
            </span>
          ))}
          {(!decision || decision.reasons.length === 0) && (
            <span className="text-body-sm text-text-secondary">{record.status_reason ? reasonLabel(record.status_reason) : 'Selected for a check.'}</span>
          )}
        </div>
        {decision && <ConfidenceBar score={decision.aggregate_score} />}
      </section>

      {decision && Object.keys(decision.thresholds_applied).length > 0 && (
        <section className="flex flex-col gap-2" aria-label="Scores against thresholds">
          <h3 className="text-body-lg text-text-primary">Score against threshold</h3>
          <ul className="flex flex-col gap-2">
            {Object.entries(decision.thresholds_applied).map(([type, applied]) => (
              <li key={type} className="flex flex-col gap-1">
                <span className="text-body-sm text-text-secondary">
                  {RESOURCE_LABELS[type] ?? type} (rule v{applied.version})
                </span>
                <ConfidenceBar score={applied.score} threshold={applied.threshold} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {decision?.reasoning_trace && (
        <section className="flex flex-col gap-1" aria-label="Reasoning">
          <h3 className="text-body-lg text-text-primary">Reasoning</h3>
          <p className="text-body-sm text-text-secondary">{decision.reasoning_trace}</p>
        </section>
      )}

      {issues.length > 0 && (
        <section className="flex flex-col gap-1" aria-label="Validation issues">
          <h3 className="text-body-lg text-text-primary">Validation issues</h3>
          <ul className="flex flex-col gap-1">
            {issues.map((issue, index) => (
              <li key={index} className="text-body-sm text-danger-text">
                {issue.resource}: {issue.message} <span className="font-mono text-text-secondary">({issue.ruleId})</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-1" aria-label="Document and consent">
        <h3 className="text-body-lg text-text-primary">Document and consent</h3>
        <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-body-sm">
          <dt className="text-text-secondary">Source</dt>
          <dd className="text-text-primary">{record.source.name}</dd>
          <dt className="text-text-secondary">Scan quality</dt>
          <dd className="text-text-primary">{record.ocr_confidence === null ? 'Digital text' : `${Math.round(record.ocr_confidence * 100)}%`}</dd>
          <dt className="text-text-secondary">Consent</dt>
          <dd className="text-text-primary">{consent ? `${consent.result.replaceAll('_', ' ')}, checked ${new Date(consent.checked_at).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC` : 'Not checked'}</dd>
        </dl>
      </section>
    </div>
  )
}
