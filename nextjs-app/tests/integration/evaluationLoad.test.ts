// The reviewer-decision loader against an in-memory database: joins, latest decision wins, purged records, holdback.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeDb } from '../support/fakeDb'

const holder = vi.hoisted(() => ({ db: null as unknown as import('../support/fakeDb').FakeDb }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => holder.db.client() }))

import { computeEvaluation } from '@/server/services/evaluation/compute'
import { loadEvaluationInputs } from '@/server/services/evaluation/load'

const SOURCE = 'src-1'
const BAR = { minRecords: 1, minFields: 1, targetHighRisk: 0.5, targetOther: 0.5, targetCode: 0.5, minResourcesAtThreshold: 1 }

const correction = (over: Record<string, unknown>) => ({
  task_id: 't1', record_id: 'r1', source_id: SOURCE, field_key: 'medication[0].name', action: 'accept',
  original_value: 'Metformin', original_code: { code: '372567009' }, corrected_code: null, reviewed_at: '2026-10-08T10:00:00Z', ...over,
})

beforeEach(() => {
  holder.db = new FakeDb()
})

describe('loadEvaluationInputs', () => {
  it('joins each decision with what the system produced, and keeps the latest decision of a field', async () => {
    const { db } = holder
    db.seed('review_corrections',
      correction({ field_key: 'medication[0].name', action: 'correct', corrected_code: { code: '999' }, reviewed_at: '2026-10-08T09:00:00Z', task_id: 't0' }),
      correction({ field_key: 'medication[0].name', action: 'accept', reviewed_at: '2026-10-08T10:00:00Z' }),
      correction({ field_key: 'medication[0].dose_value', action: 'correct', original_value: '500', reviewed_at: '2026-10-08T10:00:00Z' }),
    )
    db.seed('extracted_fields',
      { record_id: 'r1', field_key: 'medication[0].name', resource_type: 'MedicationRequest', found: true, grounded: true, basis: 'stated' },
      { record_id: 'r1', field_key: 'medication[0].dose_value', resource_type: 'MedicationRequest', found: true, grounded: true, basis: 'inferred' },
    )
    db.seed('field_scores',
      { record_id: 'r1', scope: 'field', field_key: 'medication[0].name', score: 0.97, components: { required: true } },
      { record_id: 'r1', scope: 'field', field_key: 'medication[0].dose_value', score: 0.8, components: { required: false } },
      { record_id: 'r1', scope: 'record', field_key: null, score: 0.9, components: {} },
    )
    db.seed('routing_decisions', { record_id: 'r1', escalation_reasons: ['holdback'] })
    db.seed('review_tasks', { id: 't1', claimed_at: '2026-10-08T09:59:00Z', completed_at: '2026-10-08T10:00:30Z' })

    const { fields, records } = await loadEvaluationInputs(SOURCE, null)

    expect(fields).toHaveLength(2)
    expect(fields.find((f) => f.fieldKey === 'medication[0].name')).toMatchObject({
      action: 'accept', resourceType: 'MedicationRequest', found: true, codeable: true, codeWrong: false, score: 0.97, required: true, basis: 'stated', grounded: true,
    })
    expect(fields.find((f) => f.fieldKey === 'medication[0].dose_value')).toMatchObject({ action: 'correct', codeable: false, score: 0.8, required: false, basis: 'inferred' })
    expect(records).toEqual([{ recordId: 'r1', holdback: true, decisionSeconds: 90 }])
  })

  it('marks a code the reviewer changed as wrong', async () => {
    const { db } = holder
    db.seed('review_corrections', correction({ action: 'correct', corrected_code: { code: '999' } }))
    const { fields } = await loadEvaluationInputs(SOURCE, null)
    expect(fields[0]).toMatchObject({ codeable: true, codeWrong: true })
  })

  it('still counts a record whose extracted rows were purged after a rejection', async () => {
    const { db } = holder
    db.seed('review_corrections', correction({ field_key: 'encounter[0].class', action: 'reject', original_value: 'inpatient', original_code: null }))
    const { fields } = await loadEvaluationInputs(SOURCE, null)
    expect(fields[0]).toMatchObject({ resourceType: 'Encounter', found: true, action: 'reject', score: null, grounded: true })
  })

  it('ignores other sources and decisions before the period start', async () => {
    const { db } = holder
    db.seed('review_corrections',
      correction({ record_id: 'mine-new', reviewed_at: '2026-10-08T10:00:00Z' }),
      correction({ record_id: 'mine-old', reviewed_at: '2026-01-01T10:00:00Z' }),
      correction({ record_id: 'theirs', source_id: 'other-source' }),
    )
    const { fields } = await loadEvaluationInputs(SOURCE, '2026-09-01T00:00:00Z')
    expect(fields.map((f) => f.recordId)).toEqual(['mine-new'])
  })

  it('feeds the computation end to end', async () => {
    const { db } = holder
    db.seed('review_corrections', correction({}), correction({ field_key: 'medication[0].frequency', original_code: null }))
    db.seed('extracted_fields',
      { record_id: 'r1', field_key: 'medication[0].name', resource_type: 'MedicationRequest', found: true, grounded: true, basis: 'stated' },
      { record_id: 'r1', field_key: 'medication[0].frequency', resource_type: 'MedicationRequest', found: true, grounded: true, basis: 'stated' },
    )
    const { fields, records } = await loadEvaluationInputs(SOURCE, null)
    const report = computeEvaluation({ fields, records, bar: BAR, periodDays: null })
    expect(report.evidence).toMatchObject({ records: 1, fields: 2 })
    expect(report.accuracy.overall).toMatchObject({ correct: 2, total: 2 })
  })
})
