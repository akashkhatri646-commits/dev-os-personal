import { describe, expect, it } from 'vitest'
import { DISCHARGE_SUMMARY_CATALOG } from '@/server/services/extraction/fieldCatalog'
import { commitErrorCode, commitErrorToAppError } from '@/server/services/commit/commitErrors'
import { decideRoute, reviewPriority, thresholdsChecksum, type RouteInput, type RoutedResource } from '@/server/services/routing/decide'
import { scoreRecord, type ScoreField, type ScoreResource } from '@/server/services/scoring/score'

const field = (key: string, overrides: Partial<ScoreField> = {}): ScoreField => ({
  field_key: key,
  found: true,
  grounded: true,
  basis: 'stated',
  model_confidence: 1,
  source_span: { block_ids: ['b1'] },
  ...overrides,
})

const medFields = (overrides: Record<string, Partial<ScoreField>> = {}, index = 0) =>
  ['name', 'dose_value', 'dose_unit', 'frequency'].map((attr) => field(`medication[${index}].${attr}`, overrides[attr]))

const coding = (matchConfidence: number, index = 0) => ({
  field_key: `medication[${index}].name`,
  system: 'snomed' as const,
  code: '1',
  display: 'x',
  match_confidence: matchConfidence,
  candidates: [],
})

const medication = (overrides: Partial<ScoreResource> = {}): ScoreResource => ({
  id: 'r1',
  resource_type: 'MedicationRequest',
  source_ref: 'medication[0]',
  codings: [coding(1)],
  flags: [],
  validation_status: 'pass',
  ...overrides,
})

const score = (fields: ScoreField[], resources: ScoreResource[], blockConfidence = new Map<string, number>()) =>
  scoreRecord({ fields, resources, catalog: DISCHARGE_SUMMARY_CATALOG, blockConfidence })

const byKey = (result: ReturnType<typeof score>, key: string) => result.fields.find((entry) => entry.fieldKey === key)

describe('scoreRecord edge cases', () => {
  it('scores a resource with no known source entity as 0, so the record cannot pass', () => {
    const result = score(medFields(), [medication({ source_ref: null }), medication({ id: 'r9', source_ref: 'spaceship[0]' })])
    expect(result.resources.map((entry) => entry.score)).toEqual([0, 0])
    expect(result.aggregate).toBe(0)
  })

  it('caps every field of a resource flagged as conflicting', () => {
    const result = score(medFields(), [medication({ flags: ['conflict'] })])
    expect(result.fields.every((entry) => entry.score <= 0.7 && entry.capsApplied.includes('conflict'))).toBe(true)
  })

  it('points each risk flag at the right field of a lab result and of a medication', () => {
    const lab = ['test_name', 'value', 'unit'].map((attr) => field(`lab[0].${attr}`))
    const result = score(lab, [{ id: 'l1', resource_type: 'Observation', source_ref: 'lab[0]', codings: [{ field_key: 'lab[0].test_name', system: 'loinc', code: '1', display: 'x', match_confidence: 1, candidates: [] }], flags: ['range_value', 'unit_unmapped'], validation_status: 'pass' }])
    expect(byKey(result, 'lab[0].value')?.capsApplied).toContain('range_value')
    expect(byKey(result, 'lab[0].unit')?.capsApplied).toContain('unit_unmapped')
    expect(byKey(result, 'lab[0].test_name')?.capsApplied).toEqual([])

    const unstated = score(medFields(), [medication({ flags: ['phase_unstated', 'invalid_code_selection', 'some_future_flag'] })])
    expect(byKey(unstated, 'medication[0].name')?.capsApplied).toEqual(expect.arrayContaining(['phase_unstated', 'invalid_code_selection']))
    expect(byKey(unstated, 'medication[0].dose_value')?.capsApplied).toEqual([])
  })

  it('treats a cited block with no known scan confidence as fully reliable, and averages several blocks', () => {
    const noData = score(medFields({ name: { source_span: { block_ids: ['unknown'] } } }), [medication()])
    expect(byKey(noData, 'medication[0].name')?.ocrFactor).toBe(1)
    const mixed = score(medFields({ name: { source_span: { block_ids: ['a', 'b'] } } }), [medication()], new Map([['a', 0.99], ['b', 0.95]]))
    expect(byKey(mixed, 'medication[0].name')?.capsApplied).not.toContain('low_ocr_span')
    const noSpan = score(medFields({ name: { source_span: null } }), [medication()])
    expect(byKey(noSpan, 'medication[0].name')?.ocrFactor).toBe(1)
  })

  it('never lets a model confidence missing from a found field raise the score', () => {
    const result = score(medFields({ name: { model_confidence: null } }), [medication()])
    expect(byKey(result, 'medication[0].name')?.extraction).toBe(0)
  })
})

describe('scoreRecord', () => {
  it('gives a fully certain, valid, coded record 1.0', () => {
    const result = score(medFields(), [medication()])
    expect(result.aggregate).toBe(1)
    expect(result.fields.every((entry) => entry.capsApplied.length === 0)).toBe(true)
  })

  it('applies the 0.5 / 0.3 / 0.2 weights', () => {
    const result = score(medFields({ name: { model_confidence: 0.8 } }), [medication({ codings: [coding(0.9)] })])
    // 0.5 x 0.8 + 0.3 x 0.9 + 0.2 x 1 = 0.87
    expect(byKey(result, 'medication[0].name')?.score).toBe(0.87)
  })

  it('never lets an inferred field score above 0.80', () => {
    const result = score([...medFields(), field('medication[0].phase', { basis: 'inferred', model_confidence: 0.99 })], [medication()])
    const phase = byKey(result, 'medication[0].phase')
    expect(phase?.score).toBe(0.8)
    expect(phase?.capsApplied).toContain('inferred')
    // 0.7 x min required (1.0) + 0.3 x mean (four at 1.0 and one at 0.8 = 0.96)
    expect(result.resources[0]?.score).toBeCloseTo(0.988, 3)
  })

  it('caps a field cited from a poorly scanned block and lowers E by the OCR factor', () => {
    const result = score(medFields({ dose_value: { source_span: { block_ids: ['bad'] } } }), [medication()], new Map([['bad', 0.7], ['b1', 0.99]]))
    const dose = byKey(result, 'medication[0].dose_value')
    expect(dose?.capsApplied).toContain('low_ocr_span')
    expect(dose?.score).toBe(0.75)
    expect(dose?.ocrFactor).toBeCloseTo(0.737, 3)
  })

  it('caps uncertain values at 0.70 on the field they concern', () => {
    const result = score(medFields(), [medication({ flags: ['range_value', 'unit_unmapped', 'incomplete_timing'] })])
    expect(byKey(result, 'medication[0].dose_value')?.score).toBe(0.7)
    expect(byKey(result, 'medication[0].dose_unit')?.score).toBe(0.7)
    expect(byKey(result, 'medication[0].frequency')?.score).toBe(0.7)
    expect(byKey(result, 'medication[0].name')?.score).toBe(1)
  })

  it('caps an uncoded concept and a weak match at 0.70', () => {
    const uncoded = score(medFields(), [medication({ codings: [], flags: ['uncoded'] })])
    expect(byKey(uncoded, 'medication[0].name')?.score).toBe(0.7)
    const weak = score(medFields(), [medication({ codings: [coding(0.6)] })])
    expect(byKey(weak, 'medication[0].name')?.capsApplied).toContain('weak_match')
  })

  it('scores a required field the document lacks as 0 and reports it', () => {
    const result = score(medFields({ frequency: { found: false, model_confidence: null, source_span: null } }), [medication()])
    expect(result.missingRequired).toEqual(['medication[0].frequency'])
    expect(byKey(result, 'medication[0].frequency')?.score).toBe(0)
    // 0.7 x 0 + 0.3 x (3 x 1.0 + 0) / 4
    expect(result.resources[0]?.score).toBeCloseTo(0.225, 3)
  })

  it('scores a resource that failed validation lower', () => {
    const result = score(medFields(), [medication({ validation_status: 'fail' })])
    expect(result.fields.every((entry) => entry.validation === 0)).toBe(true)
    expect(result.aggregate).toBe(0.8)
  })

  it('treats an ungrounded found field as 0', () => {
    const result = score(medFields({ name: { grounded: false } }), [medication()])
    expect(byKey(result, 'medication[0].name')?.score).toBe(0)
  })

  it('takes the lowest resource as the record score, and an empty record as 0', () => {
    const second = medication({ id: 'r2', source_ref: 'medication[1]', flags: ['uncoded'], codings: [] })
    const result = score([...medFields(), ...medFields({}, 1)], [medication(), second])
    expect(result.aggregate).toBe(Math.min(...result.resources.map((entry) => entry.score)))
    expect(result.aggregate).toBeLessThan(1)
    expect(score([], []).aggregate).toBe(0)
  })

  it('is deterministic', () => {
    expect(JSON.stringify(score(medFields(), [medication()]))).toBe(JSON.stringify(score(medFields(), [medication()])))
  })
})

const resource = (overrides: Partial<RoutedResource> = {}): RoutedResource => ({
  id: 'r1',
  type: 'MedicationRequest',
  flags: [],
  validation: 'pass',
  score: 0.995,
  ...overrides,
})

const clear = (overrides: Partial<RouteInput> = {}): RouteInput => ({
  ocrConfidence: 0.99,
  ocrFloor: 0.8,
  resources: [resource()],
  ungroundedFound: false,
  missingRequired: [],
  aggregate: 0.995,
  thresholdFor: () => ({ threshold: 0.99, version: 1 }),
  sourceAutoCommit: true,
  systemAutoCommit: true,
  injectionSuspected: false,
  holdbackPct: 0,
  ...overrides,
})

describe('decideRoute', () => {
  it('auto-commits only when everything is clear', () => {
    const result = decideRoute(clear())
    expect(result.decision).toBe('auto_commit')
    expect(result.reasons).toEqual([])
    expect(result.thresholdsApplied.MedicationRequest).toEqual({ threshold: 0.99, version: 1, score: 0.995, pass: true })
  })

  const cases: [string, Partial<RouteInput>, string][] = [
    ['low scan quality', { ocrConfidence: 0.5 }, 'low_ocr'],
    ['failed validation', { resources: [resource({ validation: 'fail' })] }, 'schema_invalid'],
    ['pending validation', { resources: [resource({ validation: 'pending' })] }, 'schema_invalid'],
    ['an ungrounded value', { ungroundedFound: true }, 'ungrounded'],
    ['a missing required field', { missingRequired: ['medication[0].frequency'] }, 'ungrounded'],
    ['no resources', { resources: [] }, 'ungrounded'],
    ['an uncoded term', { resources: [resource({ flags: ['uncoded'] })] }, 'uncoded'],
    ['a rejected code choice', { resources: [resource({ flags: ['invalid_code_selection'] })] }, 'uncoded'],
    ['a score below the threshold', { thresholdFor: () => ({ threshold: 0.999, version: 2 }) }, 'below_threshold'],
    ['a dose range', { resources: [resource({ flags: ['range_value'] })] }, 'ambiguous_label'],
    ['an unstated medication phase', { resources: [resource({ flags: ['phase_unstated'] })] }, 'ambiguous_label'],
    ['suspected injection', { injectionSuspected: true }, 'ambiguous_label'],
    ['a source with auto-commit off', { sourceAutoCommit: false }, 'source_not_enabled'],
    ['the global kill switch', { systemAutoCommit: false }, 'source_not_enabled'],
  ]
  it.each(cases)('escalates for %s, on its own', (_name, overrides, reason) => {
    const result = decideRoute(clear(overrides))
    expect(result.decision).toBe('escalate')
    expect(result.reasons).toContain(reason)
  })

  it('passes a score exactly equal to the threshold', () => {
    expect(decideRoute(clear({ resources: [resource({ score: 0.99 })] })).decision).toBe('auto_commit')
  })

  it('fails closed when the threshold is missing (1.0)', () => {
    expect(decideRoute(clear({ thresholdFor: () => ({ threshold: 1, version: null }) })).reasons).toContain('below_threshold')
  })

  it('escalates the whole record when only one resource type is below its threshold', () => {
    const result = decideRoute(clear({ resources: [resource({ id: 'a', type: 'Condition', score: 0.99 }), resource({ id: 'b', score: 0.95 })] }))
    expect(result.decision).toBe('escalate')
    expect(result.thresholdsApplied.Condition?.pass).toBe(true)
    expect(result.thresholdsApplied.MedicationRequest?.pass).toBe(false)
  })

  it('writes a trace that names the numbers and the decision', () => {
    const trace = decideRoute(clear({ thresholdFor: () => ({ threshold: 0.999, version: 2 }) })).trace
    expect(trace).toContain('MedicationRequest score 0.995 < threshold 0.999 (v2)')
    expect(trace).toContain('Decision: escalate')
  })

  it('rolls the audit sample only when nothing else escalates, and flags the holdback', () => {
    let rolls = 0
    const roll = () => {
      rolls += 1
      return 0
    }
    expect(decideRoute(clear({ holdbackPct: 10, roll }))).toMatchObject({ decision: 'escalate', holdback: true, reasons: ['holdback'] })
    decideRoute(clear({ holdbackPct: 10, roll, sourceAutoCommit: false }))
    expect(rolls).toBe(1)
    expect(decideRoute(clear({ holdbackPct: 10, roll: () => 999 })).holdback).toBe(true)
    expect(decideRoute(clear({ holdbackPct: 10, roll: () => 1000 })).decision).toBe('auto_commit')
  })

  it('samples about 10% of eligible records at holdback_pct=10', () => {
    let held = 0
    let seed = 12345
    const roll = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return Math.floor((seed / 2 ** 32) * 10_000)
    }
    for (let i = 0; i < 2000; i += 1) {
      if (decideRoute(clear({ holdbackPct: 10, roll })).holdback) held += 1
    }
    expect(held / 2000).toBeGreaterThan(0.07)
    expect(held / 2000).toBeLessThan(0.13)
  })

  it('orders review priority by risk, then scan quality, then low confidence', () => {
    const med = [resource({ score: 0.5 })]
    const cond = [resource({ type: 'Condition', score: 0.5 })]
    expect(reviewPriority(med, false, 0.5)).toBeGreaterThan(reviewPriority(cond, false, 0.5))
    expect(reviewPriority(cond, true, 0.5)).toBeGreaterThan(reviewPriority(cond, false, 0.5))
    expect(reviewPriority(cond, false, 0.2)).toBeGreaterThan(reviewPriority(cond, false, 0.9))
  })
})

describe('thresholdsChecksum', () => {
  const applied = {
    A: { threshold: 0.9, version: 1, score: 0.95, pass: true },
    B: { threshold: 0.9, version: 1, score: 0.8, pass: false },
  }

  it('is stable and changes when any value changes', () => {
    expect(thresholdsChecksum(applied)).toBe(thresholdsChecksum({ B: applied.B, A: applied.A }))
    expect(thresholdsChecksum(applied)).not.toBe(thresholdsChecksum({ ...applied, B: { ...applied.B, pass: true } }))
  })
})

describe('commit error mapping', () => {
  it('finds the stable code in a database message', () => {
    expect(commitErrorCode('P0001: consent_not_valid')).toBe('consent_not_valid')
    expect(commitErrorCode('bad_status_needs_review')).toBe('bad_status_needs_review')
    expect(commitErrorCode('already_committed')).toBe('already_committed')
    expect(commitErrorCode('connection reset')).toBeNull()
  })

  it('treats refusals as final and everything else as retryable', () => {
    expect(commitErrorToAppError({ message: 'validation_not_passed' })).toMatchObject({ retryable: false, reason: 'VALIDATION_NOT_PASSED' })
    expect(commitErrorToAppError({ message: 'connection reset' })).toMatchObject({ retryable: true })
  })
})
