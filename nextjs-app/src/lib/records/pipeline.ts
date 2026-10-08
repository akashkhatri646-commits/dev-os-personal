import type { RecordStatus } from '@/types/domain'
import type { RecordEvent } from '@/types/records'

export type StepState = 'done' | 'current' | 'pending' | 'failed' | 'blocked' | 'skipped'

export interface PipelineStep {
  id: string
  label: string
  state: StepState
  /** When the step finished, from its audit event. */
  at: string | null
  /** Time since the previous finished step. */
  durationMs: number | null
  note: string | null
}

const STEPS: readonly { id: string; label: string; events: readonly string[] }[] = [
  { id: 'consent', label: 'Consent check', events: ['consent.checked'] },
  { id: 'ocr', label: 'Reading the document', events: ['ocr.completed'] },
  { id: 'extraction', label: 'Extracting fields', events: ['extraction.completed'] },
  { id: 'mapping', label: 'Mapping to FHIR', events: ['mapping.completed'] },
  { id: 'validation', label: 'Validation', events: ['validation.completed'] },
  { id: 'scoring', label: 'Scoring', events: ['scoring.completed'] },
  { id: 'routing', label: 'Routing decision', events: ['routing.decided'] },
  { id: 'commit', label: 'Commit', events: ['record.committed'] },
]

const IN_PROGRESS: readonly RecordStatus[] = ['received', 'consent_check', 'normalizing', 'extracting', 'mapping', 'validating', 'scoring', 'routing']

/** The step index each status starts, used to find where a re-run restarted. */
const RESTART_INDEX: Partial<Record<RecordStatus, number>> = { consent_check: 0, normalizing: 1, extracting: 2, mapping: 3, validating: 4, scoring: 5, routing: 6 }
const RESTART_REASONS: readonly string[] = ['manual_retry', 'admin_rerun']

const latest = (events: readonly RecordEvent[], names: readonly string[]) => [...events].reverse().find((event) => names.includes(event.event))

/** The latest retry or re-run: from which step it restarted and when. Earlier results from that step on are out of date. */
function lastRestart(events: readonly RecordEvent[]): { index: number; at: number } | null {
  const marker = [...events].reverse().find((event) => event.event === 'record.status_changed' && RESTART_REASONS.includes(String(event.payload?.reason)))
  const index = marker ? RESTART_INDEX[marker.payload.to as RecordStatus] : undefined
  return marker && index !== undefined ? { index, at: Date.parse(marker.created_at) } : null
}

/**
 * The pipeline as a row of steps, derived from the record's audit events and status: what finished
 * and when, what is running now, what is waiting, and what was skipped because the record stopped.
 * (Records with a blocked consent show the consent step as blocked and nothing after it.)
 */
export function buildPipelineSteps(status: RecordStatus, events: readonly RecordEvent[]): PipelineStep[] {
  const steps: PipelineStep[] = []
  let previousAt: number | null = null
  let stopped = false

  const restart = lastRestart(events)

  for (const [position, step] of STEPS.entries()) {
    const found = latest(events, step.events)
    // A result from before the latest re-run, at or after the step it restarted from, belongs to the old run.
    const event = found && restart && position >= restart.index && Date.parse(found.created_at) < restart.at ? undefined : found
    const at = event ? Date.parse(event.created_at) : null
    if (event && at !== null) {
      const blocked = step.id === 'consent' && status === 'blocked_consent'
      steps.push({
        id: step.id,
        label: step.label,
        state: blocked ? 'blocked' : 'done',
        at: event.created_at,
        durationMs: previousAt === null ? null : Math.max(0, at - previousAt),
        note: blocked ? 'Consent did not allow this record' : null,
      })
      previousAt = at
      if (blocked) stopped = true
      continue
    }

    let state: StepState
    let note: string | null = null
    if (stopped || status === 'blocked_consent') {
      state = 'skipped'
    } else if (step.id === 'commit' && (status === 'needs_review' || status === 'in_review')) {
      state = 'pending'
      note = status === 'in_review' ? 'A reviewer is working on it' : 'Waiting for a reviewer'
    } else if (status === 'failed' && !steps.some((entry) => entry.state === 'failed')) {
      state = 'failed'
    } else if (status === 'received') {
      // Nothing has picked the record up yet: it is queued, not running.
      state = 'pending'
      if (steps.length === 0) note = 'Queued: waiting for the worker'
    } else if (IN_PROGRESS.includes(status) && !steps.some((entry) => entry.state === 'current')) {
      state = 'current'
    } else if (IN_PROGRESS.includes(status)) {
      state = 'pending'
    } else {
      state = 'skipped'
    }
    steps.push({ id: step.id, label: step.label, state, at: null, durationMs: null, note })
  }

  return steps
}

export function formatDuration(ms: number | null): string | null {
  if (ms === null) return null
  if (ms < 1000) return '<1 s'
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`
  return `${(ms / 3_600_000).toFixed(1)} h`
}
