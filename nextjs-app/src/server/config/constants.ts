import 'server-only'
import { getEnv } from '@/server/config/env'

/** Fixed pipeline constants (docs/specs/00-overview-and-conventions.md §8). */
export const INFERRED_SCORE_CAP = 0.8
export const LOW_OCR_SPAN_CAP = 0.75
/** Cap for ranges, unmapped units, conflicts and uncoded values: these never auto-commit. */
export const UNCERTAIN_VALUE_SCORE_CAP = 0.7
export const SCORE_WEIGHTS = { extraction: 0.5, mapping: 0.3, validation: 0.2 } as const
export const AGGREGATE_BLEND = { min: 0.7, mean: 0.3 } as const
export const ROUTING_RULE_VERSION = 'route-v1'

/** Threshold bounds enforced when editing thresholds (spec 02) live in a client-safe module. */
export {
  HIGH_RISK_RESOURCE_TYPES,
  HIGH_RISK_THRESHOLD_FLOOR,
  MIN_HOLDBACK_PCT_WHEN_ENABLED,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
} from '@/lib/sources/rules'

export interface RuntimeConfig {
  ocrConfidenceFloor: number
  defaultThreshold: number
  highRiskThreshold: number
  jobMaxAttempts: number
  reviewLockMinutes: number
  maxUploadBytes: number
  holdbackPctDefault: number
  signedUrlTtlSeconds: number
  enabledDocTypes: string[]
  systemAutoCommitEnabled: boolean
}

/** Environment-driven settings with the defaults documented in the specs. */
export function getRuntimeConfig(): RuntimeConfig {
  const env = getEnv()
  return {
    ocrConfidenceFloor: env.OCR_CONFIDENCE_FLOOR,
    defaultThreshold: env.DEFAULT_THRESHOLD,
    highRiskThreshold: env.MEDICATION_ALLERGY_THRESHOLD,
    jobMaxAttempts: env.JOB_MAX_ATTEMPTS,
    reviewLockMinutes: env.REVIEW_LOCK_MINUTES,
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
    holdbackPctDefault: env.HOLDBACK_PCT_DEFAULT,
    signedUrlTtlSeconds: env.SIGNED_URL_TTL_SECONDS,
    enabledDocTypes: env.ENABLED_DOC_TYPES,
    systemAutoCommitEnabled: env.SYSTEM_AUTOCOMMIT_ENABLED,
  }
}
