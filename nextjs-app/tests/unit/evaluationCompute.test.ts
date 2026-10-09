import { describe, expect, it } from 'vitest'
import { computeEvaluation, toRate, wilsonLower, type EvalFieldInput, type EvalRecordInput } from '@/server/services/evaluation/compute'
import type { EvalBar } from '@/types/evaluation'

const BAR: EvalBar = { minRecords: 50, minFields: 300, targetHighRisk: 0.99, targetOther: 0.97, targetCode: 0.95, minResourcesAtThreshold: 30 }

const field = (over: Partial<EvalFieldInput> = {}): EvalFieldInput => ({
  recordId: 'r1',
  fieldKey: 'medication[0].name',
  resourceType: 'MedicationRequest',
  action: 'accept',
  found: true,
  codeable: false,
  codeWrong: false,
  score: 0.98,
  required: true,
  basis: 'stated',
  grounded: true,
  ...over,
})

/** `count` records, each with `meds` medication fields and `enc` encounter fields, all accepted. */
function cleanSet(count: number, meds: number, enc: number): { fields: EvalFieldInput[]; records: EvalRecordInput[] } {
  const fields: EvalFieldInput[] = []
  const records: EvalRecordInput[] = []
  for (let r = 0; r < count; r += 1) {
    records.push({ recordId: `r${r}`, holdback: false, decisionSeconds: 30 })
    for (let m = 0; m < meds; m += 1) fields.push(field({ recordId: `r${r}`, fieldKey: `medication[0].attr${m}` }))
    for (let e = 0; e < enc; e += 1) fields.push(field({ recordId: `r${r}`, fieldKey: `encounter[0].attr${e}`, resourceType: 'Encounter' }))
  }
  return { fields, records }
}

describe('wilsonLower', () => {
  it('is honest about small samples and approaches 1 as evidence grows', () => {
    expect(wilsonLower(3, 3)).toBeCloseTo(3 / (3 + 1.645 ** 2), 3)
    expect(wilsonLower(300, 300)).toBeGreaterThan(0.99)
    expect(wilsonLower(267, 267)).toBeLessThan(0.99)
    expect(wilsonLower(0, 0)).toBeNull()
  })

  it('reports a rate with its lower bound', () => {
    expect(toRate(9, 10)).toMatchObject({ correct: 9, total: 10, rate: 0.9 })
    expect(toRate(0, 0)).toEqual({ correct: 0, total: 0, rate: null, lower: null })
  })
})

describe('computeEvaluation verdict', () => {
  it('says "insufficient evidence", not "failed", below the minimums', () => {
    const { fields, records } = cleanSet(10, 5, 3)
    const report = computeEvaluation({ fields, records, bar: BAR, periodDays: null })
    expect(report.verdict).toBe('insufficient_evidence')
    expect(report.criteria.find((entry) => entry.id === 'records')).toMatchObject({ met: false, detail: '10 of 50 needed' })
  })

  it('passes with enough evidence and no mistakes', () => {
    const { fields, records } = cleanSet(60, 5, 3)
    const report = computeEvaluation({ fields, records, bar: BAR, periodDays: null })
    expect(report.evidence).toMatchObject({ records: 60, fields: 480, records_all_accepted: 60 })
    expect(report.verdict).toBe('passed')
  })

  it('fails when one of 300 medication fields was wrong: a lower bound, not the average, decides', () => {
    const { fields, records } = cleanSet(60, 5, 3)
    fields[0] = field({ recordId: 'r0', fieldKey: 'medication[0].attr0', action: 'correct' })
    const report = computeEvaluation({ fields, records, bar: BAR, periodDays: null })
    expect(report.accuracy.high_risk.rate).toBeGreaterThan(0.99)
    expect(report.verdict).toBe('failed')
    expect(report.criteria.find((entry) => entry.id === 'accuracy_high_risk')?.met).toBe(false)
  })

  it('fails on any value that was not found in the document', () => {
    const { fields, records } = cleanSet(60, 5, 3)
    fields[1] = field({ recordId: 'r0', fieldKey: 'medication[0].attr1', grounded: false })
    const report = computeEvaluation({ fields, records, bar: BAR, periodDays: null })
    expect(report.ungrounded).toBe(1)
    expect(report.verdict).toBe('failed')
  })

  it('judges codes by whether the reviewer left them alone', () => {
    const { fields, records } = cleanSet(60, 5, 3)
    for (let i = 0; i < 60; i += 1) fields.push(field({ recordId: `r${i}`, fieldKey: 'medication[0].name', codeable: true, codeWrong: i < 10 }))
    const report = computeEvaluation({ fields, records, bar: BAR, periodDays: null })
    expect(report.accuracy.code).toMatchObject({ correct: 50, total: 60 })
    expect(report.criteria.find((entry) => entry.id === 'accuracy_code')?.met).toBe(false)
  })
})

describe('computeEvaluation field handling', () => {
  it('ignores a "not found" the reviewer accepted, and counts a value the reviewer had to supply as a miss', () => {
    const report = computeEvaluation({
      fields: [
        field({ fieldKey: 'encounter[0].discharge_date', resourceType: 'Encounter', found: false, action: 'accept' }),
        field({ fieldKey: 'encounter[0].admission_date', resourceType: 'Encounter', found: false, action: 'correct' }),
        field({ fieldKey: 'encounter[0].class', resourceType: 'Encounter', action: 'accept' }),
      ],
      records: [],
      bar: BAR,
      periodDays: null,
    })
    expect(report.accuracy.overall).toMatchObject({ correct: 1, total: 2 })
  })

  it('treats a rejected value as wrong and keeps stated and inferred values apart', () => {
    const report = computeEvaluation({
      fields: [
        field({ fieldKey: 'medication[0].phase', basis: 'inferred', action: 'accept' }),
        field({ fieldKey: 'medication[0].name', basis: 'stated', action: 'reject' }),
        field({ fieldKey: 'medication[0].frequency', basis: 'stated', action: 'accept' }),
      ],
      records: [],
      bar: BAR,
      periodDays: null,
    })
    expect(report.accuracy.inferred).toMatchObject({ correct: 1, total: 1 })
    expect(report.accuracy.stated).toMatchObject({ correct: 1, total: 2 })
  })

  it('groups by resource type and by field name without the list position', () => {
    const report = computeEvaluation({
      fields: [
        field({ fieldKey: 'medication[0].dose_value' }),
        field({ fieldKey: 'medication[1].dose_value', action: 'correct' }),
        field({ fieldKey: 'encounter[0].class', resourceType: 'Encounter' }),
      ],
      records: [],
      bar: BAR,
      periodDays: null,
    })
    expect(report.by_field.find((entry) => entry.field === 'medication.dose_value')?.rate).toMatchObject({ correct: 1, total: 2 })
    expect(report.by_resource_type.map((entry) => entry.resource_type)).toEqual(['Encounter', 'MedicationRequest'])
  })
})

describe('computeEvaluation calibration, thresholds and review behaviour', () => {
  it('compares predicted scores with what reviewers found', () => {
    const report = computeEvaluation({
      fields: [
        field({ fieldKey: 'a[0].x', score: 0.95 }),
        field({ fieldKey: 'a[0].y', score: 0.92, action: 'correct' }),
        field({ fieldKey: 'a[0].z', score: 0.65 }),
      ],
      records: [],
      bar: BAR,
      periodDays: null,
    })
    expect(report.calibration).toEqual([
      { bucket: '0.6 - 0.7', fields: 1, mean_score: 0.65, accuracy: 1 },
      { bucket: '0.9 - 1.0', fields: 2, mean_score: 0.935, accuracy: 0.5 },
    ])
  })

  it('suggests the lowest threshold whose resources were right often enough, with enough of them', () => {
    const bar: EvalBar = { ...BAR, targetOther: 0.5, minResourcesAtThreshold: 4 }
    // Eight Encounter resources, one field each: 0.99 x4 (right), 0.96 x2 (right), 0.96 x2 (wrong).
    const spec: [number, boolean][] = [[0.99, true], [0.99, true], [0.99, true], [0.99, true], [0.96, true], [0.96, true], [0.96, false], [0.96, false]]
    const fields = spec.map(([score, right], index) =>
      field({ recordId: `r${index}`, fieldKey: 'encounter[0].class', resourceType: 'Encounter', score, action: right ? 'accept' : 'correct' }),
    )
    const report = computeEvaluation({ fields, records: [], bar, periodDays: null })
    const at = (threshold: number) => report.threshold_curve.find((entry) => entry.threshold === threshold)
    // A one-field resource scores 0.7 x its field + 0.3 x its field, which is the field's own score.
    expect(at(0.98)?.resources).toBe(4)
    expect(at(0.95)?.resources).toBe(8)
    expect(at(0.95)?.rate.rate).toBe(0.75)
    // At 0.95 six of eight were right (75%) but eight resources only support "at least 45%" with 95% confidence;
    // from 0.97 the four resources above were all right, which supports at least 59%: the first to clear 50%.
    expect(report.suggested_thresholds[0]).toMatchObject({ resource_type: 'Encounter', threshold: 0.97 })
  })

  it('says "insufficient evidence" instead of suggesting a threshold from too few resources', () => {
    const report = computeEvaluation({ fields: [field({ score: 0.99 })], records: [], bar: BAR, periodDays: null })
    expect(report.suggested_thresholds[0]).toMatchObject({ threshold: null })
    expect(report.suggested_thresholds[0]?.reason).toContain('Insufficient evidence')
  })

  it('measures the audit holdback sample on its own, and shows rubber-stamp signals', () => {
    const report = computeEvaluation({
      fields: [
        field({ recordId: 'a', fieldKey: 'encounter[0].class', resourceType: 'Encounter' }),
        field({ recordId: 'b', fieldKey: 'encounter[0].class', resourceType: 'Encounter', action: 'correct' }),
        field({ recordId: 'c', fieldKey: 'encounter[0].class', resourceType: 'Encounter' }),
      ],
      records: [
        { recordId: 'a', holdback: true, decisionSeconds: 20 },
        { recordId: 'b', holdback: true, decisionSeconds: 90 },
        { recordId: 'c', holdback: false, decisionSeconds: 10 },
      ],
      bar: BAR,
      periodDays: 30,
    })
    expect(report.holdback).toMatchObject({ correct: 1, total: 2 })
    expect(report.evidence).toMatchObject({ records: 3, records_all_accepted: 2, median_decision_seconds: 20 })
    expect(report.period_days).toBe(30)
  })

  it('returns an empty report without error when nothing has been reviewed', () => {
    const report = computeEvaluation({ fields: [], records: [], bar: BAR, periodDays: null })
    expect(report.verdict).toBe('insufficient_evidence')
    expect(report.holdback).toBeNull()
    expect(report.calibration).toEqual([])
  })
})
