import {
  AGGREGATE_BLEND,
  INFERRED_SCORE_CAP,
  LOW_OCR_SPAN_CAP,
  SCORE_WEIGHTS,
  UNCERTAIN_VALUE_SCORE_CAP,
} from '@/server/config/constants'
import type { EntitySpec } from '@/server/services/extraction/fieldCatalog'
import { CODEABLE_FIELDS } from '@/server/services/mapping/map'
import type { Coding } from '@/types/domain'

/** A cited span below this mean OCR confidence caps the field's score. */
export const LOW_OCR_SPAN_CONFIDENCE = 0.8
/** OCR confidence at or above this counts as fully reliable. */
const OCR_FULL_CONFIDENCE = 0.95
/** A code chosen with this confidence or less caps the field's score. */
export const WEAK_MATCH_CONFIDENCE = 0.6

export interface ScoreField {
  field_key: string
  found: boolean
  grounded: boolean
  basis: 'stated' | 'inferred' | null
  model_confidence: number | null
  source_span: { block_ids?: string[] } | null
}

export interface ScoreResource {
  id: string
  resource_type: string
  source_ref: string | null
  codings: readonly Coding[]
  flags: readonly string[]
  validation_status: 'pass' | 'fail' | 'pending'
}

export interface ScoreInput {
  fields: readonly ScoreField[]
  resources: readonly ScoreResource[]
  catalog: readonly EntitySpec[]
  /** OCR confidence of each text block, by block id. Empty for digital text. */
  blockConfidence: ReadonlyMap<string, number>
}

export interface FieldScore {
  fieldKey: string
  resourceId: string
  extraction: number
  mapping: number
  validation: number
  ocrFactor: number
  score: number
  required: boolean
  capsApplied: string[]
  reasoning: string
}

export interface ResourceScore {
  resourceId: string
  resourceType: string
  score: number
  minRequired: number
  mean: number
}

export interface RecordScore {
  aggregate: number
  fields: FieldScore[]
  resources: ResourceScore[]
  /** Required fields the document did not provide (score 0, always escalated). */
  missingRequired: string[]
}

export const round3 = (value: number) => Math.round(value * 1000) / 1000
const fixed2 = (value: number) => value.toFixed(2)

const REF_PATTERN = /^([a-z_]+)(?:\[\d+\])?$/

/** Which attribute of an entity each risk flag is about. */
function flagTargets(flag: string, entity: string): string[] {
  switch (flag) {
    case 'range_value':
      return entity === 'medication' ? ['dose_value'] : ['value']
    case 'unit_unmapped':
      return entity === 'medication' ? ['dose_unit'] : ['unit']
    case 'incomplete_timing':
      return ['frequency']
    case 'phase_unstated':
      return ['name']
    case 'uncoded':
    case 'invalid_code_selection': {
      const spec = CODEABLE_FIELDS.find((entry) => entry.entity === entity)
      return spec ? [spec.attribute] : []
    }
    case 'conflict':
      return ['*']
    default:
      return []
  }
}

function ocrFactorFor(field: ScoreField, blockConfidence: ReadonlyMap<string, number>): { factor: number; lowOcr: boolean } {
  const values = (field.source_span?.block_ids ?? []).map((id) => blockConfidence.get(id)).filter((value): value is number => value !== undefined)
  if (values.length === 0) return { factor: 1, lowOcr: false }
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  return { factor: Math.min(1, mean / OCR_FULL_CONFIDENCE), lowOcr: mean < LOW_OCR_SPAN_CONFIDENCE }
}

function scoreResource(resource: ScoreResource, input: ScoreInput, fieldsByKey: ReadonlyMap<string, ScoreField>) {
  const entity = REF_PATTERN.exec(resource.source_ref ?? '')?.[1]
  const spec = entity ? input.catalog.find((candidate) => candidate.entity === entity) : undefined
  const scored: FieldScore[] = []
  const missing: string[] = []
  if (!entity || !spec || !resource.source_ref) return { scored, missing, spec: undefined }

  for (const attribute of spec.attributes) {
    const key = `${resource.source_ref}.${attribute.name}`
    const row = fieldsByKey.get(key)
    if (!row || !row.found) {
      if (!attribute.required) continue
      missing.push(key)
      scored.push({ fieldKey: key, resourceId: resource.id, extraction: 0, mapping: 0, validation: 0, ocrFactor: 1, score: 0, required: true, capsApplied: ['missing_required'], reasoning: `${key}: required but not found in the document → 0.00` })
      continue
    }

    const { factor, lowOcr } = ocrFactorFor(row, input.blockConfidence)
    const extraction = row.grounded ? (row.model_confidence ?? 0) * factor : 0
    const codeable = CODEABLE_FIELDS.some((entry) => entry.entity === entity && entry.attribute === attribute.name)
    const coding = codeable ? resource.codings.find((entry) => entry.field_key === key) : undefined
    const mapping = codeable ? (coding?.match_confidence ?? 0) : 1
    const validation = resource.validation_status === 'pass' ? 1 : 0
    let score = SCORE_WEIGHTS.extraction * extraction + SCORE_WEIGHTS.mapping * mapping + SCORE_WEIGHTS.validation * validation

    const caps: string[] = []
    const cap = (name: string, limit: number) => {
      caps.push(name)
      score = Math.min(score, limit)
    }
    if (!row.grounded) {
      caps.push('ungrounded')
      score = 0
    }
    if (row.basis === 'inferred') cap('inferred', INFERRED_SCORE_CAP)
    if (lowOcr) cap('low_ocr_span', LOW_OCR_SPAN_CAP)
    for (const flag of resource.flags) {
      if (flagTargets(flag, entity).some((target) => target === '*' || target === attribute.name)) cap(flag, UNCERTAIN_VALUE_SCORE_CAP)
    }
    if (coding && coding.match_confidence <= WEAK_MATCH_CONFIDENCE) cap('weak_match', UNCERTAIN_VALUE_SCORE_CAP)

    const final = round3(Math.max(0, Math.min(1, score)))
    scored.push({
      fieldKey: key,
      resourceId: resource.id,
      extraction: round3(extraction),
      mapping: round3(mapping),
      validation,
      ocrFactor: round3(factor),
      score: final,
      required: attribute.required,
      capsApplied: caps,
      reasoning: `${key}: E=${fixed2(extraction)} M=${fixed2(mapping)} V=${fixed2(validation)} → ${fixed2(final)}; ${caps.length === 0 ? 'no caps' : `caps: ${caps.join(', ')}`}`,
    })
  }
  return { scored, missing, spec }
}

/**
 * Scores every field, resource and the record from stored facts. Pure and deterministic: the same
 * inputs always give the same numbers, and no model output can raise a score.
 */
export function scoreRecord(input: ScoreInput): RecordScore {
  const fieldsByKey = new Map(input.fields.map((field) => [field.field_key, field]))
  const fields: FieldScore[] = []
  const resources: ResourceScore[] = []
  const missingRequired: string[] = []

  for (const resource of input.resources) {
    const { scored, missing } = scoreResource(resource, input, fieldsByKey)
    fields.push(...scored)
    missingRequired.push(...missing)
    if (scored.length === 0) {
      resources.push({ resourceId: resource.id, resourceType: resource.resource_type, score: 0, minRequired: 0, mean: 0 })
      continue
    }
    const required = scored.filter((field) => field.required)
    const minRequired = Math.min(...(required.length > 0 ? required : scored).map((field) => field.score))
    const mean = scored.reduce((total, field) => total + field.score, 0) / scored.length
    resources.push({
      resourceId: resource.id,
      resourceType: resource.resource_type,
      score: round3(AGGREGATE_BLEND.min * minRequired + AGGREGATE_BLEND.mean * mean),
      minRequired: round3(minRequired),
      mean: round3(mean),
    })
  }

  const aggregate = resources.length === 0 ? 0 : Math.min(...resources.map((resource) => resource.score))
  return { aggregate: round3(aggregate), fields, resources, missingRequired }
}
