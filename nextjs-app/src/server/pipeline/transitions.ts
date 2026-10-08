import { AppError } from '@/lib/api/errors'
import type { RecordStatus } from '@/types/domain'

export type JobStage =
  | 'consent_check'
  | 'normalize'
  | 'extract'
  | 'map'
  | 'validate'
  | 'score'
  | 'route'
  | 'commit'

/** Allowed status transitions (docs/specs/00-overview-and-conventions.md §4). */
export const TRANSITIONS: Record<RecordStatus, readonly RecordStatus[]> = {
  received: ['consent_check', 'failed'],
  consent_check: ['blocked_consent', 'normalizing', 'failed'],
  normalizing: ['extracting', 'needs_review', 'failed'],
  extracting: ['mapping', 'needs_review', 'failed'],
  mapping: ['validating', 'needs_review', 'failed'],
  validating: ['scoring', 'needs_review', 'failed'],
  scoring: ['routing', 'needs_review', 'failed'],
  routing: ['auto_committed', 'needs_review', 'blocked_consent', 'failed'],
  needs_review: ['in_review', 'rejected', 'blocked_consent'],
  in_review: ['committed', 'rejected', 'needs_review', 'blocked_consent'],
  blocked_consent: [],
  auto_committed: [],
  committed: [],
  rejected: [],
  failed: [],
}

export const TERMINAL_STATUSES: readonly RecordStatus[] = [
  'blocked_consent',
  'auto_committed',
  'committed',
  'rejected',
  'failed',
]

/** Status a record shows while a given stage is running. */
export const STAGE_STATUS: Record<JobStage, RecordStatus> = {
  consent_check: 'consent_check',
  normalize: 'normalizing',
  extract: 'extracting',
  map: 'mapping',
  validate: 'validating',
  score: 'scoring',
  route: 'routing',
  commit: 'routing',
}

/** Default successor of each stage. `commit` ends the pipeline. */
export const NEXT_STAGE: Record<JobStage, JobStage | null> = {
  consent_check: 'normalize',
  normalize: 'extract',
  extract: 'map',
  map: 'validate',
  validate: 'score',
  score: 'route',
  route: 'commit',
  commit: null,
}

/** Statuses from which an operator may re-run a stage (spec 03 §3, retry). */
export const RETRYABLE_STATUSES: readonly RecordStatus[] = ['failed', 'needs_review']

export function isTerminal(status: RecordStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

export function canTransition(from: RecordStatus, to: RecordStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/** Throws `INVALID_TRANSITION` (409) unless the move is allowed. A retry may leave a retryable status. */
export function assertTransition(from: RecordStatus, to: RecordStatus, options: { retry?: boolean } = {}): void {
  if (from === to) return
  if (options.retry && RETRYABLE_STATUSES.includes(from)) return
  if (!canTransition(from, to)) {
    throw new AppError('INVALID_TRANSITION', `A record cannot move from ${from} to ${to}.`, {
      reason: `${from}->${to}`,
    })
  }
}

/** Delay before a failed job is retried: 15 seconds multiplied by the attempt number. */
export function retryDelaySeconds(attempts: number): number {
  return 15 * Math.max(1, attempts)
}

/** Stage encoded in a `stage_error:<stage>` status reason, or null. */
export function stageFromReason(reason: string | null | undefined): JobStage | null {
  const match = /^stage_error:(\w+)$/.exec(reason ?? '')
  const stage = match?.[1]
  return stage && stage in STAGE_STATUS ? (stage as JobStage) : null
}
