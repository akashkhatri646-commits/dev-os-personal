import { createHash, randomInt } from 'node:crypto'
import { ROUTING_RULE_VERSION } from '@/server/config/constants'
import { round3 } from '@/server/services/scoring/score'
import type { EscalationReason } from '@/types/domain'

/** Risk flags that mean a value was uncertain: these never auto-commit, whatever the score. */
const AMBIGUITY_FLAGS = ['range_value', 'unit_unmapped', 'incomplete_timing', 'phase_unstated', 'conflict']
const UNCODED_FLAGS = ['uncoded', 'invalid_code_selection']
const HIGH_RISK_TYPES = ['MedicationRequest', 'AllergyIntolerance', 'Observation']

export interface RoutedResource {
  id: string
  type: string
  flags: readonly string[]
  validation: 'pass' | 'fail' | 'pending'
  score: number
}

export interface RouteInput {
  /** Mean OCR confidence of the document, or null for digital text. */
  ocrConfidence: number | null
  ocrFloor: number
  resources: readonly RoutedResource[]
  /** A found value that was never grounded (cannot normally happen: extraction stores only grounded values). */
  ungroundedFound: boolean
  missingRequired: readonly string[]
  aggregate: number
  thresholdFor: (resourceType: string) => { threshold: number; version: number | null }
  sourceAutoCommit: boolean
  systemAutoCommit: boolean
  injectionSuspected: boolean
  holdbackPct: number
  /** Integer in [0, 10000). Injected so tests are deterministic. */
  roll?: () => number
}

export interface AppliedThreshold {
  threshold: number
  version: number
  score: number
  pass: boolean
}

export interface RouteDecision {
  decision: 'auto_commit' | 'escalate'
  reasons: EscalationReason[]
  /** The strictest result per resource type, as stored on the decision. */
  thresholdsApplied: Record<string, AppliedThreshold>
  validation: 'pass' | 'fail'
  holdback: boolean
  trace: string
  ruleVersion: string
  /** Static part of the review-queue priority (spec 09 §2). */
  priority: number
}

/** Tamper check for the stored thresholds, verified again at commit. */
export function thresholdsChecksum(applied: Record<string, AppliedThreshold>): string {
  const ordered = Object.keys(applied).sort().map((key) => [key, applied[key]])
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}

export function reviewPriority(resources: readonly RoutedResource[], lowOcr: boolean, aggregate: number): number {
  const risky = resources.some((resource) => HIGH_RISK_TYPES.includes(resource.type))
  const riskWeight = (risky ? 1 : 0.5) + (lowOcr ? 0.5 : 0)
  return Math.round((100 * riskWeight + 50 * (1 - aggregate)) * 1000) / 1000
}

/**
 * The routing rule (spec 08 §3): plain code, no model. Auto-commit only when every check is clear.
 * The audit-sample roll happens last and only when nothing else would escalate the record.
 */
export function decideRoute(input: RouteInput): RouteDecision {
  const reasons: EscalationReason[] = []
  const lowOcr = input.ocrConfidence !== null && input.ocrConfidence < input.ocrFloor
  if (lowOcr) reasons.push('low_ocr')

  const validation = input.resources.length > 0 && input.resources.every((resource) => resource.validation === 'pass') ? 'pass' : 'fail'
  if (validation === 'fail') reasons.push('schema_invalid')

  if (input.ungroundedFound || input.missingRequired.length > 0 || input.resources.length === 0) reasons.push('ungrounded')
  if (input.resources.some((resource) => resource.flags.some((flag) => UNCODED_FLAGS.includes(flag)))) reasons.push('uncoded')

  const thresholdsApplied: Record<string, AppliedThreshold> = {}
  const belowParts: string[] = []
  for (const resource of input.resources) {
    const { threshold, version } = input.thresholdFor(resource.type)
    const existing = thresholdsApplied[resource.type]
    if (existing && existing.score <= resource.score) continue
    thresholdsApplied[resource.type] = { threshold, version: version ?? 0, score: resource.score, pass: round3(resource.score) >= threshold }
  }
  for (const [type, applied] of Object.entries(thresholdsApplied)) {
    if (!applied.pass) {
      belowParts.push(`${type} score ${applied.score.toFixed(3)} < threshold ${applied.threshold.toFixed(3)} (v${applied.version})`)
    }
  }
  if (belowParts.length > 0) reasons.push('below_threshold')

  if (input.injectionSuspected || input.resources.some((resource) => resource.flags.some((flag) => AMBIGUITY_FLAGS.includes(flag)))) {
    reasons.push('ambiguous_label')
  }
  if (!input.sourceAutoCommit || !input.systemAutoCommit) reasons.push('source_not_enabled')

  let holdback = false
  if (reasons.length === 0 && input.holdbackPct > 0) {
    const roll = (input.roll ?? (() => randomInt(0, 10_000)))()
    if (roll < input.holdbackPct * 100) {
      holdback = true
      reasons.push('holdback')
    }
  }

  const decision = reasons.length === 0 ? 'auto_commit' : 'escalate'
  const parts = [
    `Record aggregate ${input.aggregate.toFixed(3)}.`,
    ...Object.entries(thresholdsApplied).map(([type, applied]) =>
      applied.pass
        ? `${type} score ${applied.score.toFixed(3)} ≥ threshold ${applied.threshold.toFixed(3)} (v${applied.version}).`
        : `${type} score ${applied.score.toFixed(3)} < threshold ${applied.threshold.toFixed(3)} (v${applied.version}) → below_threshold.`,
    ),
    `Validation: ${validation}.`,
    lowOcr ? `OCR confidence ${(input.ocrConfidence ?? 0).toFixed(3)} below the ${input.ocrFloor.toFixed(2)} floor → low_ocr.` : '',
    input.missingRequired.length > 0 ? `Missing required fields: ${input.missingRequired.length} → ungrounded.` : '',
    `Source auto-commit: ${input.sourceAutoCommit && input.systemAutoCommit ? 'enabled' : 'not enabled'}.`,
    `Decision: ${decision}${reasons.length > 0 ? ` (${reasons.join(', ')})` : ''}.`,
  ].filter(Boolean)

  return {
    decision,
    reasons,
    thresholdsApplied,
    validation,
    holdback,
    trace: parts.join(' '),
    ruleVersion: ROUTING_RULE_VERSION,
    priority: reviewPriority(input.resources, lowOcr, input.aggregate),
  }
}
