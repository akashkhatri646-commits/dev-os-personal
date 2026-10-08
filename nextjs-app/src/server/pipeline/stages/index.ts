import type { RecordRow } from '@/server/pipeline/orchestrator'
import { consentCheckStage } from '@/server/pipeline/stages/consentCheck'
import { extractStage } from '@/server/pipeline/stages/extract'
import { mapStage } from '@/server/pipeline/stages/map'
import { commitStage } from '@/server/pipeline/stages/commit'
import { normalizeStage } from '@/server/pipeline/stages/normalize'
import { routeStage } from '@/server/pipeline/stages/route'
import { scoreStage } from '@/server/pipeline/stages/score'
import { validateStage } from '@/server/pipeline/stages/validate'
import type { JobStage } from '@/server/pipeline/transitions'
import type { JobRow } from '@/server/queue/jobs'

/** What a stage handler reports back to the worker. */
export type StageOutcome =
  /** Stage done: queue the default next stage. */
  | { kind: 'advance' }
  /** Stage done but the same stage must run again (e.g. next extraction chunk). */
  | { kind: 'repeat' }
  /** Pipeline finished for this record (committed, blocked, or otherwise terminal): queue nothing. */
  | { kind: 'finished' }
  /** Automation must stop: send the record to review with a reason code. */
  | {
      kind: 'escalate'
      reason: string
      /** Static queue priority; higher is reviewed sooner. */
      priority?: number
      /** Review task kind; `escalation` unless this is a random audit sample. */
      taskKind?: 'holdback_audit'
    }
  /** Not now: put the job back untouched and try again after this many seconds (breaker open, spend cap reached). */
  | { kind: 'defer'; seconds: number }
  /** The record cannot be processed at all: mark it failed with a reason code. */
  | { kind: 'fail'; reason: string }

export interface StageContext {
  record: RecordRow
  job: JobRow
}

/**
 * A stage handler is idempotent: it reads its inputs from the database, writes its outputs by
 * upsert, and may be run again after a crash or retry without producing duplicates.
 */
export type StageHandler = (context: StageContext) => Promise<StageOutcome>

/**
 * Handlers registered by each pipeline feature as it lands (consent, normalisation, extraction,
 * mapping, validation, scoring, routing, commit). A job for a stage without a handler is released
 * back to the queue untouched, so records wait safely until that stage is deployed.
 */
export const STAGE_HANDLERS: Partial<Record<JobStage, StageHandler>> = {
  consent_check: consentCheckStage,
  normalize: normalizeStage,
  extract: extractStage,
  map: mapStage,
  validate: validateStage,
  score: scoreStage,
  route: routeStage,
  commit: commitStage,
}
