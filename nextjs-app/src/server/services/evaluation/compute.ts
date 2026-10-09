import { HIGH_RISK_RESOURCE_TYPES } from '@/lib/sources/rules'
import { AGGREGATE_BLEND } from '@/server/config/constants'
import type { EvalBar, EvalCriterion, EvalReport, EvalVerdict, Rate } from '@/types/evaluation'

/** One reviewed field: what the system produced and what the reviewer decided. */
export interface EvalFieldInput {
  recordId: string
  /** For example `medication[0].dose_value`. */
  fieldKey: string
  resourceType: string
  action: 'accept' | 'correct' | 'reject'
  /** The system found a value (false: it reported "not found"). */
  found: boolean
  codeable: boolean
  /** The reviewer changed the code or rejected the field. */
  codeWrong: boolean
  /** The field score at the time of routing, or null when none was stored. */
  score: number | null
  required: boolean
  basis: 'stated' | 'inferred' | null
  grounded: boolean
}

export interface EvalRecordInput {
  recordId: string
  /** The record was randomly held back for review after it passed every threshold. */
  holdback: boolean
  /** Seconds between the reviewer claiming the task and finishing it. */
  decisionSeconds: number | null
}

export interface ComputeInput {
  fields: readonly EvalFieldInput[]
  records: readonly EvalRecordInput[]
  bar: EvalBar
  periodDays: number | null
  now?: Date
}

/** One-sided 95%: "we are 95% sure the true accuracy is at least this". */
const Z = 1.645
/** Thresholds tried when asking "what if only resources scoring at least this were committed unseen". */
export const THRESHOLD_GRID = [0.8, 0.85, 0.9, 0.93, 0.95, 0.97, 0.98, 0.99] as const
const BUCKETS = [0.5, 0.6, 0.7, 0.8, 0.9] as const

const round3 = (value: number) => Math.round(value * 1000) / 1000

/** Wilson score lower bound: honest about small samples (3 of 3 is not "100% accurate"). */
export function wilsonLower(correct: number, total: number, z = Z): number | null {
  if (total === 0) return null
  const p = correct / total
  const z2 = z * z
  const centre = p + z2 / (2 * total)
  const margin = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))
  return Math.max(0, (centre - margin) / (1 + z2 / total))
}

export function toRate(correct: number, total: number): Rate {
  const lower = wilsonLower(correct, total)
  return { correct, total, rate: total === 0 ? null : round3(correct / total), lower: lower === null ? null : round3(lower) }
}

const entityRef = (fieldKey: string) => fieldKey.split('.')[0] ?? fieldKey
/** `medication[0].dose_value` -> `medication.dose_value`. */
const fieldName = (fieldKey: string) => fieldKey.replace(/\[\d+\]/g, '')
const isHighRisk = (resourceType: string) => (HIGH_RISK_RESOURCE_TYPES as readonly string[]).includes(resourceType)

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[middle] ?? null) : (((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
}

function group<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item])
  return groups
}

const countCorrect = (fields: readonly EvalFieldInput[]) => fields.filter((field) => field.action === 'accept').length

interface ResourceResult {
  recordId: string
  resourceType: string
  score: number
  correct: boolean
}

/** A resource's score by the system's own rule (weakest required field and the average), so it matches what routing saw. */
function resourceResults(fields: readonly EvalFieldInput[]): ResourceResult[] {
  const results: ResourceResult[] = []
  for (const members of group(fields, (field) => `${field.recordId}|${entityRef(field.fieldKey)}`).values()) {
    const scored = members.filter((field) => field.score !== null)
    const first = members[0]
    if (scored.length === 0 || !first) continue
    const scores = scored.map((field) => field.score as number)
    const required = scored.filter((field) => field.required).map((field) => field.score as number)
    const weakest = Math.min(...(required.length > 0 ? required : scores))
    const mean = scores.reduce((total, value) => total + value, 0) / scores.length
    results.push({
      recordId: first.recordId,
      resourceType: first.resourceType,
      score: AGGREGATE_BLEND.min * weakest + AGGREGATE_BLEND.mean * mean,
      correct: members.every((field) => field.action === 'accept'),
    })
  }
  return results
}

function criterion(id: string, label: string, met: boolean | null, detail: string): EvalCriterion {
  return { id, label, met, detail }
}

const percent = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`)

/**
 * Turns reviewer decisions into the evaluation report. Pure and deterministic: nothing here calls a model or reads
 * the database, so the same decisions always give the same numbers.
 */
export function computeEvaluation(input: ComputeInput): EvalReport {
  const { bar } = input
  // A field counts when the system gave a value, or when the reviewer had to supply one it missed.
  const evaluated = input.fields.filter((field) => field.found || field.action === 'correct')

  const highRisk = evaluated.filter((field) => isHighRisk(field.resourceType))
  const other = evaluated.filter((field) => !isHighRisk(field.resourceType))
  const coded = evaluated.filter((field) => field.codeable && field.found)
  const inferred = evaluated.filter((field) => field.basis === 'inferred')
  const stated = evaluated.filter((field) => field.basis !== 'inferred')
  const ungrounded = evaluated.filter((field) => field.found && !field.grounded).length

  const accuracy = {
    overall: toRate(countCorrect(evaluated), evaluated.length),
    high_risk: toRate(countCorrect(highRisk), highRisk.length),
    other: toRate(countCorrect(other), other.length),
    code: toRate(coded.filter((field) => !field.codeWrong && field.action !== 'reject').length, coded.length),
    stated: toRate(countCorrect(stated), stated.length),
    inferred: toRate(countCorrect(inferred), inferred.length),
  }

  const byResourceType = [...group(evaluated, (field) => field.resourceType)]
    .map(([resource_type, members]) => ({ resource_type, rate: toRate(countCorrect(members), members.length) }))
    .sort((a, b) => a.resource_type.localeCompare(b.resource_type))
  const byField = [...group(evaluated, (field) => fieldName(field.fieldKey))]
    .map(([field, members]) => ({ field, rate: toRate(countCorrect(members), members.length) }))
    .sort((a, b) => (a.rate.rate ?? 1) - (b.rate.rate ?? 1) || a.field.localeCompare(b.field))

  const scoredFields = evaluated.filter((field) => field.score !== null)
  const calibration = BUCKETS.map((low, index) => {
    const high = BUCKETS[index + 1] ?? 1.0001
    const members = scoredFields.filter((field) => (field.score as number) >= low && (field.score as number) < high)
    const meanScore = members.length === 0 ? 0 : members.reduce((total, field) => total + (field.score as number), 0) / members.length
    return {
      bucket: `${low.toFixed(1)} - ${index === BUCKETS.length - 1 ? '1.0' : high.toFixed(1)}`,
      fields: members.length,
      mean_score: round3(meanScore),
      accuracy: members.length === 0 ? null : round3(countCorrect(members) / members.length),
    }
  }).filter((bucket) => bucket.fields > 0)

  const resources = resourceResults(evaluated)
  const resourceTypes = [...new Set(resources.map((resource) => resource.resourceType))].sort()
  const thresholdCurve: EvalReport['threshold_curve'] = []
  const suggested: EvalReport['suggested_thresholds'] = []
  for (const resourceType of resourceTypes) {
    const ofType = resources.filter((resource) => resource.resourceType === resourceType)
    const target = isHighRisk(resourceType) ? bar.targetHighRisk : bar.targetOther
    let chosen: number | null = null
    for (const threshold of THRESHOLD_GRID) {
      const above = ofType.filter((resource) => resource.score >= threshold)
      if (above.length === 0) continue
      const rate = toRate(above.filter((resource) => resource.correct).length, above.length)
      thresholdCurve.push({ resource_type: resourceType, threshold, resources: above.length, rate })
      if (chosen === null && above.length >= bar.minResourcesAtThreshold && (rate.lower ?? 0) >= target) chosen = threshold
    }
    suggested.push({
      resource_type: resourceType,
      threshold: chosen,
      reason:
        chosen !== null
          ? `Resources scoring at least ${chosen} were right often enough (95% sure of at least ${percent(target)}).`
          : ofType.length < bar.minResourcesAtThreshold
            ? `Insufficient evidence: ${ofType.length} reviewed, ${bar.minResourcesAtThreshold} needed.`
            : `No threshold tried reaches ${percent(target)} with enough resources above it.`,
    })
  }

  const holdbackIds = new Set(input.records.filter((record) => record.holdback).map((record) => record.recordId))
  const heldBack = resources.filter((resource) => holdbackIds.has(resource.recordId))

  const recordIds = new Set(input.fields.map((field) => field.recordId))
  const allAccepted = [...recordIds].filter((id) => input.fields.filter((field) => field.recordId === id).every((field) => field.action === 'accept')).length
  const evidence = {
    records: recordIds.size,
    fields: evaluated.length,
    records_all_accepted: allAccepted,
    median_decision_seconds: median(input.records.map((record) => record.decisionSeconds).filter((value): value is number => value !== null)),
  }

  const criteria = [
    criterion('records', 'Reviewed records', evidence.records >= bar.minRecords, `${evidence.records} of ${bar.minRecords} needed`),
    criterion('fields', 'Reviewed fields', evidence.fields >= bar.minFields, `${evidence.fields} of ${bar.minFields} needed`),
    criterion(
      'accuracy_high_risk',
      'Medication, allergy and lab fields',
      accuracy.high_risk.total === 0 ? null : (accuracy.high_risk.lower ?? 0) >= bar.targetHighRisk,
      accuracy.high_risk.total === 0
        ? 'No such fields reviewed yet'
        : `${percent(accuracy.high_risk.rate)} right (95% sure of at least ${percent(accuracy.high_risk.lower)}); need ${percent(bar.targetHighRisk)}`,
    ),
    criterion(
      'accuracy_other',
      'All other fields',
      accuracy.other.total === 0 ? null : (accuracy.other.lower ?? 0) >= bar.targetOther,
      accuracy.other.total === 0
        ? 'No such fields reviewed yet'
        : `${percent(accuracy.other.rate)} right (95% sure of at least ${percent(accuracy.other.lower)}); need ${percent(bar.targetOther)}`,
    ),
    criterion(
      'accuracy_code',
      'Codes',
      accuracy.code.total === 0 ? null : (accuracy.code.rate ?? 0) >= bar.targetCode,
      accuracy.code.total === 0 ? 'No coded fields reviewed yet' : `${percent(accuracy.code.rate)} unchanged by reviewers; need ${percent(bar.targetCode)}`,
    ),
    criterion('ungrounded', 'Values not found in the document', ungrounded === 0, ungrounded === 0 ? 'None' : `${ungrounded} found; none are allowed`),
  ]

  let verdict: EvalVerdict
  const evidenceMet = criteria.slice(0, 2).every((entry) => entry.met === true)
  if (!evidenceMet) verdict = 'insufficient_evidence'
  else if (criteria.slice(2).some((entry) => entry.met === false)) verdict = 'failed'
  else verdict = 'passed'

  return {
    generated_at: (input.now ?? new Date()).toISOString(),
    period_days: input.periodDays,
    verdict,
    bar,
    evidence,
    accuracy,
    ungrounded,
    by_resource_type: byResourceType,
    by_field: byField,
    calibration,
    threshold_curve: thresholdCurve,
    suggested_thresholds: suggested,
    holdback: heldBack.length === 0 ? null : toRate(heldBack.filter((resource) => resource.correct).length, heldBack.length),
    criteria,
  }
}
