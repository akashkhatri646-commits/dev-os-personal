import { beforeEach, describe, expect, it, vi } from 'vitest'

const { state } = vi.hoisted(() => ({ state: { byDisplay: [] as unknown[], bySynonym: [] as unknown[], orCalls: [] as string[], error: null as { message: string } | null } }))

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: () => {
      const query: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'limit']) query[method] = () => query
      query.or = (expression: string) => {
        state.orCalls.push(expression)
        const result = Promise.resolve({ data: expression.startsWith('synonyms.') ? state.bySynonym : state.byDisplay, error: state.error })
        return result
      }
      return query
    },
  }),
}))
vi.mock('@/server/config/env', () => ({ getEnv: () => ({}) }))
vi.mock('@/server/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { getEmbeddingsClient, SupabaseTerminologySearch, MIN_CANDIDATE_SCORE } from '@/server/services/terminology/search'

const concept = (code: string, display: string, synonyms: string[] = [], resource_types: string[] = ['Condition']) => ({ system: 'snomed', code, display, synonyms, resource_types })

beforeEach(() => {
  state.byDisplay = []
  state.bySynonym = []
  state.orCalls = []
  state.error = null
})

describe('word-matching terminology search', () => {
  it('finds a concept by a word in its name, best match first', async () => {
    state.byDisplay = [concept('73211009', 'Diabetes mellitus'), concept('44054006', 'Diabetes mellitus type 2')]
    const hits = await new SupabaseTerminologySearch().search('Type 2 diabetes mellitus', 'snomed', 'Condition', 5)
    expect(hits.map((hit) => hit.code)).toEqual(['44054006', '73211009'])
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 1)
  })

  it('finds a concept by a synonym that is not in its name, and merges both lookups without duplicates', async () => {
    state.bySynonym = [concept('22298006', 'Myocardial infarction', ['heart attack', 'mi'])]
    state.byDisplay = [concept('22298006', 'Myocardial infarction', ['heart attack', 'mi'])]
    const hits = await new SupabaseTerminologySearch().search('Heart attack', 'snomed', 'Condition', 5)
    expect(hits.map((hit) => hit.code)).toEqual(['22298006'])
    expect(hits[0]?.score).toBeGreaterThan(0.8)
    expect(state.orCalls.some((call) => call.startsWith('synonyms.cs.{') && call.includes('"heart attack"'))).toBe(true)
  })

  it('matches short synonyms such as "mi" and "af", which the word filter alone would drop', async () => {
    state.bySynonym = [concept('49436004', 'Atrial fibrillation', ['af', 'afib'])]
    const hits = await new SupabaseTerminologySearch().search('AF', 'snomed', 'Condition', 5)
    expect(hits.map((hit) => hit.code)).toEqual(['49436004'])
    expect(state.orCalls.some((call) => call.includes('"af"'))).toBe(true)
  })

  it('offers a concept only for the resource types it is meant for, and drops weak matches', async () => {
    state.byDisplay = [concept('372567009', 'Metformin', [], ['MedicationRequest']), concept('1', 'Metformin overdose adverse event unrelated words', [], ['Condition'])]
    const forCondition = await new SupabaseTerminologySearch().search('Metformin', 'snomed', 'Condition', 5)
    expect(forCondition.every((hit) => hit.code !== '372567009')).toBe(true)
    expect(forCondition.every((hit) => hit.score >= MIN_CANDIDATE_SCORE)).toBe(true)
    const forMedication = await new SupabaseTerminologySearch().search('Metformin', 'snomed', 'MedicationRequest', 5)
    expect(forMedication[0]).toMatchObject({ code: '372567009', score: expect.any(Number) })
  })

  it('treats an empty table as no candidates, and strips characters that could break the filter', async () => {
    expect(await new SupabaseTerminologySearch().search('Metformin', 'snomed', 'MedicationRequest', 5)).toEqual([])
    await new SupabaseTerminologySearch().search('a"b{c},d\\e', 'snomed', 'Condition', 5)
    const synonymCall = state.orCalls.find((call) => call.startsWith('synonyms.')) ?? ''
    expect(synonymCall).not.toMatch(/[\\{](?!")/u)
    expect(synonymCall.slice('synonyms.cs.{'.length, -1)).not.toContain('\\')
  })

  it('reports a database failure as retryable', async () => {
    state.error = { message: 'down' }
    await expect(new SupabaseTerminologySearch().search('Metformin', 'snomed', 'MedicationRequest', 5)).rejects.toMatchObject({ retryable: true })
  })

  it('has no embeddings client until a provider and model are set', () => {
    expect(getEmbeddingsClient()).toBeNull()
  })
})
