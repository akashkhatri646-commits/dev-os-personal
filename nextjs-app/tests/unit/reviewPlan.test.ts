import { describe, expect, it } from 'vitest'
import { DISCHARGE_SUMMARY_CATALOG } from '@/server/services/extraction/fieldCatalog'
import { NodeFhirValidator } from '@/server/services/fhir/validator'
import type { StoredField } from '@/server/services/mapping/entities'
import { applyDecisions, checkDecisions, coerceValue, rebuildResources } from '@/server/services/review/submitPlan'
import { buildWorkspaceResources, visibleDecision, type WorkspaceInput } from '@/server/services/review/workspace'
import type { ReviewDecision } from '@/lib/validation/review'
import type { Coding } from '@/types/domain'

const span = { page: 1, block_ids: ['b1'], quote: 'Tab Metformin 500 mg BD', char_start: 0, char_end: 22 }
const stored = (field_key: string, value: string | number, basis: 'stated' | 'inferred' = 'stated'): StoredField => ({
  field_key,
  found: true,
  value,
  source_span: span,
  basis,
  model_confidence: 0.95,
})

const rows: StoredField[] = [
  stored('encounter.admission_date', '2025-03-01'),
  stored('encounter.discharge_date', '2025-03-05'),
  stored('encounter.class', 'inpatient', 'inferred'),
  stored('medication[0].name', 'Metformin'),
  stored('medication[0].dose_value', 500),
  stored('medication[0].dose_unit', 'mg'),
  stored('medication[0].frequency', 'twice daily'),
  stored('medication[0].phase', 'discharge', 'inferred'),
]

const coding: Coding = {
  field_key: 'medication[0].name',
  system: 'snomed',
  code: '372567009',
  display: 'Metformin',
  match_confidence: 0.9,
  candidates: [
    { code: '372567009', display: 'Metformin', score: 0.9 },
    { code: '108', display: 'Metformin hydrochloride', score: 0.8 },
  ],
}

const input = (overrides: Partial<WorkspaceInput> = {}): WorkspaceInput => ({
  resources: [
    { id: 'enc-1', resource_type: 'Encounter', source_ref: 'encounter', codings: [], flags: [], validation_status: 'pass', validation_issues: [] },
    { id: 'med-1', resource_type: 'MedicationRequest', source_ref: 'medication[0]', codings: [coding], flags: [], validation_status: 'pass', validation_issues: [] },
  ],
  fields: rows.map((row) => ({ ...row, source_span: row.source_span as never })),
  scores: [
    { scope: 'resource', field_key: null, resource_id: 'med-1', score: 0.9, components: {} },
    ...['name', 'dose_value', 'dose_unit', 'frequency'].map((attr) => ({ scope: 'field' as const, field_key: `medication[0].${attr}`, resource_id: 'med-1', score: 1, components: { caps_applied: [] } })),
    { scope: 'field', field_key: 'medication[0].phase', resource_id: 'med-1', score: 0.8, components: { caps_applied: ['inferred'] } },
    ...['admission_date', 'discharge_date'].map((attr) => ({ scope: 'field' as const, field_key: `encounter.${attr}`, resource_id: 'enc-1', score: 1, components: { caps_applied: [] } })),
    { scope: 'field', field_key: 'encounter.class', resource_id: 'enc-1', score: 0.8, components: { caps_applied: ['inferred'] } },
  ],
  thresholds: { MedicationRequest: { threshold: 0.95 }, Encounter: { threshold: 0.95 } },
  catalog: DISCHARGE_SUMMARY_CATALOG,
  ...overrides,
})

const fieldsOf = (workspace = buildWorkspaceResources(input())) => workspace.flatMap((resource) => resource.fields)

describe('buildWorkspaceResources', () => {
  it('lists the fields of each resource with labels, scores and codes', () => {
    const resources = buildWorkspaceResources(input())
    const medication = resources.find((resource) => resource.id === 'med-1')
    const name = medication?.fields.find((field) => field.field_key === 'medication[0].name')
    expect(name).toMatchObject({ label: 'Medication 1 · Name', value: 'Metformin', required: true, codeable: { system: 'snomed' } })
    expect(name?.coding?.code).toBe('372567009')
    expect(medication?.threshold).toBe(0.95)
    expect(medication?.score).toBe(0.9)
  })

  it('asks for a decision only where the score is low or the field was held down', () => {
    const needs = fieldsOf().filter((field) => field.needs_decision).map((field) => field.field_key)
    expect(needs.sort()).toEqual(['encounter.class', 'medication[0].phase'])
  })

  it('shows a required field the document lacks and requires a decision for it', () => {
    const withoutFrequency = input({ fields: input().fields.filter((row) => row.field_key !== 'medication[0].frequency') })
    const field = fieldsOf(buildWorkspaceResources(withoutFrequency)).find((entry) => entry.field_key === 'medication[0].frequency')
    expect(field).toMatchObject({ found: false, value: null, needs_decision: true, concerns: ['missing_required'] })
  })

  it('requires a decision for everything when the record was never routed', () => {
    expect(fieldsOf(buildWorkspaceResources(input({ thresholds: {} }))).every((field) => field.needs_decision)).toBe(true)
  })

  it('offers fixed choices for fixed-choice fields', () => {
    const frequency = fieldsOf().find((field) => field.field_key === 'medication[0].frequency')
    expect(frequency?.choices).toContain('twice daily')
  })
})

describe('visibleDecision', () => {
  const decision = { reasons: ['holdback'], reasoning_trace: 'Record aggregate 0.990. Validation: pass. Decision: escalate (holdback).' }
  it('hides the audit-sample reason from reviewers but not from admins', () => {
    expect(visibleDecision(decision, 'holdback_audit', false)).toEqual({ reasons: [], reasoning_trace: 'Record aggregate 0.990. Validation: pass.' })
    expect(visibleDecision(decision, 'holdback_audit', true).reasons).toEqual(['holdback'])
    expect(visibleDecision({ reasons: ['uncoded'], reasoning_trace: 'x Decision: escalate (uncoded).' }, 'escalation', false).reasons).toEqual(['uncoded'])
  })
})

const decide = (decisions: ReviewDecision[]) => checkDecisions(fieldsOf(), decisions)
const accept = (key: string): ReviewDecision => ({ field_key: key, action: 'accept' })

describe('checkDecisions', () => {
  it('lists every field that still needs a decision', () => {
    expect(decide([]).map((issue) => `${issue.reason}:${issue.field_key}`).sort()).toEqual(['DECISION_MISSING:encounter.class', 'DECISION_MISSING:medication[0].phase'])
  })

  it('passes once all required decisions are made, and others default to accept', () => {
    expect(decide([accept('encounter.class'), accept('medication[0].phase')])).toEqual([])
  })

  it('rejects unknown fields, duplicate decisions, empty corrections and rejecting a required field', () => {
    const issues = decide([
      accept('encounter.class'),
      accept('medication[0].phase'),
      accept('medication[0].phase'),
      accept('nonsense[0].field'),
      { field_key: 'medication[0].dose_value', action: 'correct' },
      { field_key: 'medication[0].name', action: 'reject' },
    ])
    expect(issues.map((issue) => issue.reason).sort()).toEqual(['DUPLICATE_DECISION', 'REJECT_REQUIRED', 'UNKNOWN_FIELD', 'VALUE_REQUIRED'])
  })
})

describe('coerceValue', () => {
  it('converts by field kind and rejects what does not fit', () => {
    expect(coerceValue('number', null, '250')).toEqual({ value: 250 })
    expect(coerceValue('number', null, 'lots')).toHaveProperty('error')
    expect(coerceValue('number', null, 0)).toHaveProperty('error')
    expect(coerceValue('valueOrText', null, '5.5')).toEqual({ value: 5.5 })
    expect(coerceValue('valueOrText', null, 'Positive')).toEqual({ value: 'Positive' })
    expect(coerceValue('date', null, '2025-03-01')).toEqual({ value: '2025-03-01' })
    expect(coerceValue('date', null, '01/03/2025')).toHaveProperty('error')
    expect(coerceValue('frequency', ['twice daily'], 'Twice Daily')).toEqual({ value: 'twice daily' })
    expect(coerceValue('frequency', ['twice daily'], 'bid')).toHaveProperty('error')
    expect(coerceValue('text', null, '  Metformin ')).toEqual({ value: 'Metformin' })
    expect(coerceValue('text', null, '  ')).toHaveProperty('error')
  })
})

const apply = (decisions: ReviewDecision[], codeDisplays = new Map<string, string>()) =>
  applyDecisions({
    fields: fieldsOf(),
    storedRows: rows,
    existingCodings: [coding],
    decisions,
    catalog: DISCHARGE_SUMMARY_CATALOG,
    codeDisplays,
  })

describe('applyDecisions', () => {
  const required = [accept('encounter.class'), accept('medication[0].phase')]

  it('stores one correction row per field and leaves untouched fields as accept', () => {
    const { applied, issues } = apply(required)
    expect(issues).toEqual([])
    expect(applied.corrections).toHaveLength(fieldsOf().length)
    expect(applied.corrections.every((row) => row.action === 'accept')).toBe(true)
    expect(applied.counts).toEqual({ accepted: fieldsOf().length, corrected: 0, rejected: 0 })
    expect(applied.changed).toEqual([])
  })

  it('changes only the corrected field', () => {
    const { applied } = apply([...required, { field_key: 'medication[0].dose_value', action: 'correct', value: 250, note: 'printed 250' }])
    expect(applied.corrections.filter((row) => row.action !== 'accept').map((row) => row.field_key)).toEqual(['medication[0].dose_value'])
    expect(applied.corrections.find((row) => row.action === 'correct')).toMatchObject({ original_value: 500, corrected_value: 250, note: 'printed 250' })
    expect(applied.changed).toMatchObject([{ field_key: 'medication[0].dose_value', value: 250, basis: 'stated', resource_type: 'MedicationRequest' }])
    expect(applied.finalRows.find((row) => row.field_key === 'medication[0].dose_value')?.value).toBe(250)
  })

  it('rejects a bad value without applying anything', () => {
    const { issues } = apply([...required, { field_key: 'medication[0].frequency', action: 'correct', value: 'bid' }])
    expect(issues).toMatchObject([{ reason: 'INVALID_VALUE', field_key: 'medication[0].frequency' }])
  })

  it('accepts a reviewer-chosen code that exists, flagging one outside the offered candidates', () => {
    const offered = apply([...required, { field_key: 'medication[0].name', action: 'correct', code: { system: 'snomed', code: '108' } }], new Map([['snomed|108', 'Metformin hydrochloride']]))
    expect(offered.issues).toEqual([])
    expect(offered.applied.overrides.size).toBe(0)
    expect(offered.applied.codings.get('medication[0].name')).toMatchObject({ code: '108', match_confidence: 1 })

    const outside = apply([...required, { field_key: 'medication[0].name', action: 'correct', code: { system: 'snomed', code: '999' } }], new Map([['snomed|999', 'Other']]))
    expect(outside.applied.overrides.has('medication[0].name')).toBe(true)
    expect(outside.applied.corrections.find((row) => row.action === 'correct')?.corrected_code).toMatchObject({ code: '999', reviewer_code_override: true })
  })

  it('rejects a code that is not in the terminology', () => {
    const { issues } = apply([...required, { field_key: 'medication[0].name', action: 'correct', code: { system: 'snomed', code: '123' } }])
    expect(issues).toMatchObject([{ reason: 'INVALID_CODE' }])
  })

  it('drops the old code when the text is corrected without a new code', () => {
    const { applied } = apply([...required, { field_key: 'medication[0].name', action: 'correct', value: 'Glucophage' }])
    expect(applied.codings.has('medication[0].name')).toBe(false)
  })

  it('marks a rejected optional field as removed', () => {
    const { applied } = apply([accept('encounter.class'), { field_key: 'medication[0].phase', action: 'reject' }])
    expect(applied.removed).toEqual(['medication[0].phase'])
    expect(applied.finalRows.some((row) => row.field_key === 'medication[0].phase')).toBe(false)
    expect(applied.counts.rejected).toBe(1)
  })

  it('does not let a missing required value be accepted as it is', () => {
    const missing = input({ fields: input().fields.filter((row) => row.field_key !== 'medication[0].frequency') })
    const { issues } = applyDecisions({
      fields: fieldsOf(buildWorkspaceResources(missing)),
      storedRows: rows.filter((row) => row.field_key !== 'medication[0].frequency'),
      existingCodings: [coding],
      decisions: [...required, accept('medication[0].frequency')],
      catalog: DISCHARGE_SUMMARY_CATALOG,
      codeDisplays: new Map(),
    })
    expect(issues).toMatchObject([{ reason: 'VALUE_REQUIRED', field_key: 'medication[0].frequency' }])
  })

  it('supplies a value for a missing required field with a manual span', () => {
    const missing = input({ fields: input().fields.filter((row) => row.field_key !== 'medication[0].frequency') })
    const fields = fieldsOf(buildWorkspaceResources(missing))
    const { applied, issues } = applyDecisions({
      fields,
      storedRows: rows.filter((row) => row.field_key !== 'medication[0].frequency'),
      existingCodings: [coding],
      decisions: [...required, { field_key: 'medication[0].frequency', action: 'correct', value: 'once daily' }],
      catalog: DISCHARGE_SUMMARY_CATALOG,
      codeDisplays: new Map(),
    })
    expect(issues).toEqual([])
    const row = applied.finalRows.find((entry) => entry.field_key === 'medication[0].frequency')
    expect(row?.value).toBe('once daily')
    expect(row?.source_span).toMatchObject({ manual: true })
  })
})

describe('rebuildResources', () => {
  const rebuild = (finalRows: StoredField[], codings = new Map([[coding.field_key, coding]])) => {
    let counter = 0
    return rebuildResources({
      rows: finalRows,
      codings,
      patientId: 'p1',
      existingIds: new Map([['encounter', 'enc-1'], ['medication[0]', 'med-1']]),
      newId: () => `new-${++counter}`,
    })
  }

  it('keeps the ids of entities that still exist so references stay valid', () => {
    const built = rebuild(rows)
    expect(built.map((entry) => entry.id)).toEqual(['enc-1', 'med-1'])
    expect((built[1]?.resource.encounter as { reference: string }).reference).toBe('Encounter/enc-1')
  })

  it('gives a new id only to a new entity', () => {
    const built = rebuild([...rows, stored('diagnosis[0].text', 'Hypertension')])
    expect(built.find((entry) => entry.sourceRef === 'diagnosis[0]')?.id).toBe('new-1')
  })

  it('produces resources the validator passes after a valid correction, and fails after clearing a required value', async () => {
    const validator = new NodeFhirValidator()
    const check = async (finalRows: StoredField[]) => {
      const built = rebuild(finalRows)
      return validator.validate(built.map((entry) => entry.resource), { patientId: 'p1', resourceIds: new Set(built.map((entry) => entry.id)), now: new Date('2026-01-01') })
    }
    expect((await check(rows)).every((result) => result.status === 'pass')).toBe(true)
    const withoutDose = rows.filter((row) => row.field_key !== 'medication[0].dose_value')
    const results = await check(withoutDose)
    expect(results.every((result) => result.status === 'pass')).toBe(true)
    const noClass = rows.filter((row) => row.field_key !== 'encounter.class')
    expect((await check(noClass)).some((result) => result.status === 'fail')).toBe(true)
  })
})
