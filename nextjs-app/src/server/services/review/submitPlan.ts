import { buildResources, type BuiltResource } from '@/server/services/fhir/builders'
import { parseFieldKey, type AttributeKind, type EntitySpec } from '@/server/services/extraction/fieldCatalog'
import { groupFields, type StoredField } from '@/server/services/mapping/entities'
import type { ReviewDecision } from '@/lib/validation/review'
import type { CodeSystem, Coding } from '@/types/domain'
import type { ReviewAction, WorkspaceField } from '@/types/review'

export type DecisionIssueReason =
  | 'DECISION_MISSING'
  | 'UNKNOWN_FIELD'
  | 'DUPLICATE_DECISION'
  | 'VALUE_REQUIRED'
  | 'INVALID_VALUE'
  | 'INVALID_CODE'
  | 'REJECT_REQUIRED'

export interface DecisionIssue {
  field_key: string
  reason: DecisionIssueReason
  message: string
}

/** The row stored for each field decision: the labeled data calibration learns from. */
export interface CorrectionRow {
  field_key: string
  action: ReviewAction
  original_value: string | number | null
  corrected_value: string | number | null
  original_code: { system: CodeSystem; code: string; display: string } | null
  corrected_code: { system: CodeSystem; code: string; display: string; reviewer_code_override?: boolean } | null
  source_span: Record<string, unknown> | null
  note: string | null
}

export interface FinalField {
  field_key: string
  resource_type: string
  value: string | number
  source_page: number | null
  source_span: Record<string, unknown>
  basis: 'stated' | 'inferred'
  model_confidence: number
}

export interface AppliedDecisions {
  /** Every found field after the decisions, including fields that belong to no resource. */
  finalRows: StoredField[]
  /** Fields the reviewer changed or supplied (written back over the extracted values). */
  changed: FinalField[]
  /** Fields the reviewer rejected (marked not found). */
  removed: string[]
  codings: Map<string, Coding>
  /** Coded fields whose chosen code was not one of the offered candidates. */
  overrides: Set<string>
  corrections: CorrectionRow[]
  counts: { accepted: number; corrected: number; rejected: number }
}

const MANUAL_SPAN = { page: 0, block_ids: [] as string[], quote: '', char_start: 0, char_end: 0, manual: true }
const DATE_PATTERN = /^\d{4}(-\d{2}(-\d{2})?)?$/

/** Problems with the set of decisions, before any value is applied. An empty list means they can be applied. */
export function checkDecisions(fields: readonly WorkspaceField[], decisions: readonly ReviewDecision[]): DecisionIssue[] {
  const issues: DecisionIssue[] = []
  const byKey = new Map(fields.map((field) => [field.field_key, field]))
  const seen = new Set<string>()

  for (const decision of decisions) {
    const field = byKey.get(decision.field_key)
    if (!field) {
      issues.push({ field_key: decision.field_key, reason: 'UNKNOWN_FIELD', message: 'This field is not part of the record.' })
      continue
    }
    if (seen.has(decision.field_key)) {
      issues.push({ field_key: decision.field_key, reason: 'DUPLICATE_DECISION', message: 'There is more than one decision for this field.' })
      continue
    }
    seen.add(decision.field_key)
    if (decision.action === 'correct' && decision.value === undefined && !decision.code) {
      issues.push({ field_key: decision.field_key, reason: 'VALUE_REQUIRED', message: 'A correction needs a value or a code.' })
    }
    if (decision.action === 'reject' && field.required) {
      issues.push({ field_key: decision.field_key, reason: 'REJECT_REQUIRED', message: 'A required value cannot be rejected; reject the whole record instead.' })
    }
  }

  for (const field of fields) {
    if (field.needs_decision && !seen.has(field.field_key)) {
      issues.push({ field_key: field.field_key, reason: 'DECISION_MISSING', message: 'This field needs a decision.' })
    }
  }
  return issues
}

/** Converts a corrected value to what the field holds, or returns an error message. */
export function coerceValue(kind: AttributeKind, choices: readonly string[] | null, raw: string | number): { value: string | number } | { error: string } {
  const text = String(raw).trim()
  if (text === '') return { error: 'The value is empty.' }
  switch (kind) {
    case 'number': {
      const number = Number(text)
      return Number.isFinite(number) && number > 0 ? { value: number } : { error: 'Enter a number greater than zero.' }
    }
    case 'valueOrText': {
      const number = Number(text)
      return { value: Number.isFinite(number) && /^-?\d+(\.\d+)?$/.test(text) ? number : text }
    }
    case 'date':
      return DATE_PATTERN.test(text) && !Number.isNaN(Date.parse(text)) ? { value: text } : { error: 'Use a date like 2025-03-01.' }
    case 'enum':
    case 'frequency':
    case 'route':
    case 'unit': {
      const choice = choices?.find((option) => option === text.toLowerCase())
      return choice ? { value: choice } : { error: `Choose one of: ${(choices ?? []).join(', ')}.` }
    }
    default:
      return { value: text }
  }
}

interface ApplyInput {
  fields: readonly WorkspaceField[]
  /** All found rows for the record, so fields outside any resource are kept. */
  storedRows: readonly StoredField[]
  existingCodings: readonly Coding[]
  decisions: readonly ReviewDecision[]
  catalog: readonly EntitySpec[]
  /** Display text for each reviewer-chosen code, keyed `system|code`; a missing key means the code is unknown. */
  codeDisplays: ReadonlyMap<string, string>
}

/**
 * Applies the reviewer's decisions to the extracted values. Fields without an explicit decision are
 * kept as they are (stored as `accept` so the labeled set is complete). Returns what to write and
 * any invalid corrections; nothing is written when `issues` is not empty.
 */
export function applyDecisions(input: ApplyInput): { applied: AppliedDecisions; issues: DecisionIssue[] } {
  const issues: DecisionIssue[] = []
  const decisionByKey = new Map(input.decisions.map((decision) => [decision.field_key, decision]))
  const rows = new Map(input.storedRows.map((row) => [row.field_key, { ...row }]))
  const codings = new Map(input.existingCodings.map((coding) => [coding.field_key, coding]))
  const changed = new Map<string, FinalField>()
  const removed: string[] = []
  const overrides = new Set<string>()
  const corrections: CorrectionRow[] = []
  const counts = { accepted: 0, corrected: 0, rejected: 0 }

  for (const field of input.fields) {
    const decision = decisionByKey.get(field.field_key) ?? { field_key: field.field_key, action: 'accept' as const }
    const originalCode = field.coding ? { system: field.coding.system, code: field.coding.code, display: field.coding.display } : null
    const base = {
      field_key: field.field_key,
      original_value: field.found ? field.value : null,
      original_code: originalCode,
      source_span: field.span as unknown as Record<string, unknown> | null,
      note: decision.note ?? null,
    }

    if (decision.action === 'accept' && !field.found && field.required) {
      issues.push({ field_key: field.field_key, reason: 'VALUE_REQUIRED', message: 'This required value is missing: supply it, or reject the record.' })
      continue
    }

    if (decision.action === 'accept') {
      counts.accepted += 1
      corrections.push({ ...base, action: 'accept', corrected_value: null, corrected_code: null })
      continue
    }

    if (decision.action === 'reject') {
      counts.rejected += 1
      rows.delete(field.field_key)
      codings.delete(field.field_key)
      codings.delete(`${field.field_key}#2`)
      if (field.found) removed.push(field.field_key)
      corrections.push({ ...base, action: 'reject', corrected_value: null, corrected_code: null })
      continue
    }

    // correct
    let value: string | number | null = field.found ? field.value : null
    if (decision.value !== undefined) {
      const coerced = coerceValue(field.kind, field.choices, decision.value)
      if ('error' in coerced) {
        issues.push({ field_key: field.field_key, reason: 'INVALID_VALUE', message: coerced.error })
        continue
      }
      value = coerced.value
    }
    if (value === null) {
      issues.push({ field_key: field.field_key, reason: 'VALUE_REQUIRED', message: 'A correction needs a value.' })
      continue
    }

    let correctedCode: CorrectionRow['corrected_code'] = null
    if (decision.code) {
      const display = input.codeDisplays.get(`${decision.code.system}|${decision.code.code}`)
      if (display === undefined || !field.codeable) {
        issues.push({ field_key: field.field_key, reason: 'INVALID_CODE', message: 'This code is not in the terminology for this field.' })
        continue
      }
      const offered = field.coding?.candidates.some((candidate) => candidate.code === decision.code?.code) === true || field.coding?.code === decision.code.code
      if (!offered) overrides.add(field.field_key)
      correctedCode = { system: decision.code.system, code: decision.code.code, display, ...(offered ? {} : { reviewer_code_override: true }) }
      codings.set(field.field_key, {
        field_key: field.field_key,
        system: decision.code.system,
        code: decision.code.code,
        display,
        match_confidence: 1,
        candidates: field.coding?.candidates ?? [],
      })
      codings.delete(`${field.field_key}#2`)
    } else if (field.codeable && decision.value !== undefined) {
      // The text changed but no new code was chosen: the old code no longer describes it.
      codings.delete(field.field_key)
      codings.delete(`${field.field_key}#2`)
    }

    const parsed = parseFieldKey(field.field_key)
    const entity = parsed ? input.catalog.find((candidate) => candidate.entity === parsed.entity) : undefined
    const span = field.span ?? MANUAL_SPAN
    const final: FinalField = {
      field_key: field.field_key,
      resource_type: entity?.resourceType ?? 'Encounter',
      value,
      source_page: span.page > 0 ? span.page : null,
      source_span: span as unknown as Record<string, unknown>,
      basis: 'stated',
      model_confidence: 1,
    }
    changed.set(field.field_key, final)
    rows.set(field.field_key, {
      field_key: field.field_key,
      found: true,
      value,
      source_span: span as never,
      basis: 'stated',
      model_confidence: 1,
    })
    counts.corrected += 1
    corrections.push({
      ...base,
      action: 'correct',
      corrected_value: decision.value !== undefined ? value : null,
      corrected_code: correctedCode,
      source_span: span as unknown as Record<string, unknown>,
    })
  }

  return {
    applied: { finalRows: [...rows.values()], changed: [...changed.values()], removed, codings, overrides, corrections, counts },
    issues,
  }
}

export interface RebuildInput {
  rows: readonly StoredField[]
  codings: ReadonlyMap<string, Coding>
  patientId: string
  /** Resource ids by source entity, so an unchanged entity keeps its id and its references. */
  existingIds: ReadonlyMap<string, string>
  newId: () => string
}

/** Rebuilds the FHIR resources from the final values with the same builders the pipeline used. */
export function rebuildResources(input: RebuildInput): BuiltResource[] {
  return buildResources(groupFields(input.rows), {
    patientId: input.patientId,
    encounterId: null,
    newId: (sourceRef) => input.existingIds.get(sourceRef) ?? input.newId(),
    codings: input.codings,
  })
}
