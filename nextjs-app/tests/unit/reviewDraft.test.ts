import { describe, expect, it } from 'vitest'
import { canApprove, countDecisions, localIssues, toSubmitDecisions, type Draft } from '@/lib/review/draft'
import { locateQuote } from '@/lib/review/locate'
import { concernLabel, fieldLabel } from '@/lib/review/labels'
import type { WorkspaceField, WorkspaceResource } from '@/types/review'

const field = (key: string, overrides: Partial<WorkspaceField> = {}): WorkspaceField => ({
  field_key: key,
  label: key,
  value: 'x',
  found: true,
  required: false,
  basis: 'stated',
  confidence: 0.9,
  score: 0.9,
  concerns: [],
  needs_decision: false,
  span: null,
  coding: null,
  codeable: null,
  kind: 'text',
  choices: null,
  ...overrides,
})

const resource = (fields: WorkspaceField[]): WorkspaceResource => ({
  id: 'r1',
  resource_type: 'MedicationRequest',
  validation_status: 'pass',
  validation_issues: [],
  score: 0.9,
  threshold: 0.95,
  flags: [],
  fields,
})

const resources = [
  resource([
    field('medication[0].name', { required: true, needs_decision: true }),
    field('medication[0].dose_value', { required: true }),
    field('medication[0].phase', { needs_decision: true }),
  ]),
]

describe('review draft', () => {
  it('counts pending decisions until each needed field has one, and implicit accepts as accepted', () => {
    expect(countDecisions(resources, {})).toEqual({ accepted: 1, corrected: 0, rejected: 0, pending: 2 })
    const draft: Draft = { 'medication[0].name': { action: 'accept' }, 'medication[0].phase': { action: 'reject' }, 'medication[0].dose_value': { action: 'correct', value: '250' } }
    expect(countDecisions(resources, draft)).toEqual({ accepted: 1, corrected: 1, rejected: 1, pending: 0 })
  })

  it('allows approval only when nothing is pending and nothing is invalid', () => {
    expect(canApprove(resources, {})).toBe(false)
    expect(canApprove(resources, { 'medication[0].name': { action: 'accept' }, 'medication[0].phase': { action: 'accept' } })).toBe(true)
    expect(canApprove([], {})).toBe(false)
  })

  it('flags an empty correction, a missing required value accepted as is, and rejecting a required value', () => {
    const draft: Draft = {
      'medication[0].name': { action: 'correct' },
      'medication[0].dose_value': { action: 'reject' },
      'medication[0].phase': { action: 'accept' },
    }
    expect(Object.keys(localIssues(resources, draft)).sort()).toEqual(['medication[0].dose_value', 'medication[0].name'])
    const missing = [resource([field('a.b', { required: true, found: false, needs_decision: true })])]
    expect(localIssues(missing, { 'a.b': { action: 'accept' } })['a.b']).toMatch(/missing/)
    expect(canApprove(resources, draft)).toBe(false)
  })

  it('sends only explicit decisions for known fields, trimming values and dropping empty notes', () => {
    const draft: Draft = {
      'medication[0].name': { action: 'correct', value: '  Glucophage ', code: { system: 'snomed', code: '1', display: 'x' }, note: ' ' },
      'medication[0].phase': { action: 'accept', note: 'ok' },
      'gone[0].field': { action: 'accept' },
    }
    expect(toSubmitDecisions(resources, draft)).toEqual([
      { field_key: 'medication[0].name', action: 'correct', value: 'Glucophage', code: { system: 'snomed', code: '1' } },
      { field_key: 'medication[0].phase', action: 'accept', note: 'ok' },
    ])
  })
})

describe('review labels', () => {
  it('turns field keys and concerns into plain words', () => {
    expect(fieldLabel('medication[1].dose_value')).toBe('Medication 2 · Dose value')
    expect(fieldLabel('encounter.admission_date')).toBe('Encounter · Admission date')
    expect(fieldLabel('weird')).toBe('weird')
    expect(concernLabel('low_ocr_span')).toBe('Poor scan quality')
    expect(concernLabel('something_new')).toBe('Something new')
  })
})

describe('locateQuote', () => {
  const text = 'Discharge medications:\nTab Metformin   500 mg BD x 30 days'
  it('finds an exact quote and one that differs in case or spacing', () => {
    expect(locateQuote(text, 'Tab Metformin')).toEqual([23, 36])
    const loose = locateQuote(text, 'tab metformin 500 mg')
    expect(loose && text.slice(loose[0], loose[1])).toBe('Tab Metformin   500 mg')
  })

  it('returns null for a quote that is not on the page, or an empty one', () => {
    expect(locateQuote(text, 'Aspirin 75 mg')).toBeNull()
    expect(locateQuote(text, '   ')).toBeNull()
  })

  it('treats special characters in a quote literally', () => {
    expect(locateQuote('dose (5-10 mg) daily', '(5-10 mg)')).toEqual([5, 14])
  })
})
