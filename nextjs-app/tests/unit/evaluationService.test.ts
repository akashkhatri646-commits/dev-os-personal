import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BASE_ENV } from '../support/baseEnv'
import type { EvalFieldInput, EvalRecordInput } from '@/server/services/evaluation/compute'

const h = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  source: { id: 's-1', eval_status: 'none', auto_commit_enabled: false } as Record<string, unknown>,
  passedRun: null as Record<string, unknown> | null,
  inputs: { fields: [] as unknown[], records: [] as unknown[] },
  inserted: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server/config/env', () => ({ getEnv: () => ({ ...BASE_ENV, ...h.env }) }))
vi.mock('@/server/services/audit/auditLog', () => ({ appendAudit: async (entry: Record<string, unknown>) => void h.audits.push(entry) }))
vi.mock('@/server/services/evaluation/load', () => ({ loadEvaluationInputs: async () => h.inputs }))
vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: table === 'provider_sources' ? h.source : h.passedRun, error: null }),
        insert: async (row: Record<string, unknown>) => {
          h.inserted.push(row)
          return { error: null }
        },
        update: (row: Record<string, unknown>) => {
          h.updates.push(row)
          return { eq: () => ({ eq: async () => ({ error: null }) }) }
        },
        then: (resolve: (value: unknown) => void) => resolve({ data: [{ resource_type: '*', threshold: 0.97 }], error: null }),
      }
      return chain
    },
  }),
}))

import { assertEvaluationCurrent, resetEvaluation, runEvaluation } from '@/server/services/evaluation/evaluationService'

const admin = { userId: 'u-1', orgId: 'org-1', role: 'admin' } as never

const field = (over: Partial<EvalFieldInput> = {}): EvalFieldInput => ({
  recordId: 'r1', fieldKey: 'medication[0].name', resourceType: 'MedicationRequest', action: 'accept', found: true, codeable: false,
  codeWrong: false, score: 0.98, required: true, basis: 'stated', grounded: true, ...over,
})

/** Enough clean evidence to pass the default bar. */
function passingInputs() {
  const fields: EvalFieldInput[] = []
  const records: EvalRecordInput[] = []
  for (let r = 0; r < 60; r += 1) {
    records.push({ recordId: `r${r}`, holdback: false, decisionSeconds: 30 })
    for (let m = 0; m < 5; m += 1) fields.push(field({ recordId: `r${r}`, fieldKey: `medication[0].a${m}` }))
    for (let e = 0; e < 3; e += 1) fields.push(field({ recordId: `r${r}`, fieldKey: `encounter[0].a${e}`, resourceType: 'Encounter' }))
  }
  return { fields, records }
}

beforeEach(() => {
  // The settings loader supplies these defaults in the real app.
  h.env = { LLM_MODEL_EXTRACTION: 'model-a', EVAL_MIN_RECORDS: 50, EVAL_MIN_FIELDS: 300, EVAL_TARGET_ACCURACY: 0.99, EVAL_TARGET_ACCURACY_OTHER: 0.97, EVAL_TARGET_CODE_ACCURACY: 0.95, EVAL_MIN_RESOURCES_AT_THRESHOLD: 30 }
  h.source = { id: 's-1', eval_status: 'none', auto_commit_enabled: false }
  h.passedRun = null
  h.inputs = { fields: [], records: [] }
  h.inserted.length = 0
  h.updates.length = 0
  h.audits.length = 0
})

describe('runEvaluation', () => {
  it('only an admin may run it', async () => {
    await expect(runEvaluation({ ...(admin as object), role: 'integration_engineer' } as never, 's-1', { basis: 'synthetic' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('answers 409 and stores nothing when there is not enough evidence', async () => {
    h.inputs = { fields: [field()], records: [] }
    await expect(runEvaluation(admin, 's-1', { basis: 'synthetic' })).rejects.toMatchObject({ code: 'CONFLICT', reason: 'INSUFFICIENT_EVIDENCE' })
    expect(h.inserted).toHaveLength(0)
    expect(h.updates).toHaveLength(0)
  })

  it('stores a pass with its basis and the model it covered, and marks the source passed', async () => {
    h.inputs = passingInputs()
    const view = await runEvaluation(admin, 's-1', { basis: 'synthetic', note: 'pilot' })
    expect(view.verdict).toBe('passed')
    expect(h.inserted[0]).toMatchObject({ kind: 'source_onboarding', source_id: 's-1', passed: true, basis: 'synthetic', sample_count: 60, prompt_set: { model_id: 'model-a' } })
    expect(h.updates[0]).toMatchObject({ eval_status: 'passed', eval_basis: 'synthetic' })
    expect(h.audits[0]).toMatchObject({ event: 'source.eval_run', payload: expect.objectContaining({ verdict: 'passed', basis: 'synthetic', note: 'pilot' }) })
  })

  it('stores a failure, marks the source failed, and switches auto-commit off', async () => {
    h.source = { id: 's-1', eval_status: 'passed', auto_commit_enabled: true }
    const inputs = passingInputs()
    inputs.fields[0] = field({ recordId: 'r0', fieldKey: 'medication[0].a0', action: 'correct' })
    h.inputs = inputs
    const view = await runEvaluation(admin, 's-1', { basis: 'real' })
    expect(view.verdict).toBe('failed')
    expect(h.updates[0]).toMatchObject({ eval_status: 'failed', eval_basis: null, auto_commit_enabled: false })
    expect(h.audits[0]).toMatchObject({ payload: expect.objectContaining({ verdict: 'failed', auto_commit_switched_off: true }) })
  })
})

describe('resetEvaluation', () => {
  it('clears a pass and switches auto-commit off in one update, and audits why', async () => {
    h.source = { id: 's-1', eval_status: 'passed', auto_commit_enabled: true }
    await resetEvaluation({ orgId: 'org-1', sourceId: 's-1', actorId: 'u-1', reason: 'thresholds_changed' })
    expect(h.updates[0]).toEqual({ eval_status: 'none', eval_passed_at: null, eval_basis: null, auto_commit_enabled: false })
    expect(h.audits[0]).toMatchObject({ event: 'source.eval_reset', payload: expect.objectContaining({ reason: 'thresholds_changed', auto_commit_was_enabled: true }) })
  })

  it('does nothing when there is no evaluation to clear', async () => {
    await resetEvaluation({ orgId: 'org-1', sourceId: 's-1', actorId: null, reason: 'thresholds_changed' })
    expect(h.updates).toHaveLength(0)
    expect(h.audits).toHaveLength(0)
  })
})

describe('assertEvaluationCurrent', () => {
  it('refuses when the pass covered a different model than the one in use', async () => {
    h.source = { id: 's-1', eval_status: 'passed', auto_commit_enabled: false }
    h.passedRun = { ran_at: 'x', passed: true, basis: 'synthetic', sample_count: 60, prompt_set: { model_id: 'model-old' } }
    await expect(assertEvaluationCurrent('org-1', 's-1')).rejects.toMatchObject({ reason: 'EVAL_STALE' })
  })

  it('accepts a pass for the current model, and has nothing to say when nothing has passed', async () => {
    h.source = { id: 's-1', eval_status: 'passed', auto_commit_enabled: false }
    h.passedRun = { ran_at: 'x', passed: true, basis: 'synthetic', sample_count: 60, prompt_set: { model_id: 'model-a' } }
    await expect(assertEvaluationCurrent('org-1', 's-1')).resolves.toBeUndefined()
    h.source = { id: 's-1', eval_status: 'none', auto_commit_enabled: false }
    await expect(assertEvaluationCurrent('org-1', 's-1')).resolves.toBeUndefined()
  })
})
