import { describe, expect, it, vi } from 'vitest'
import { groupFields, type StoredField } from '@/server/services/mapping/entities'
import { mapCodes, planMappingItems, verifyChoice, type MappingItem } from '@/server/services/mapping/map'
import { MAPPING_JSON_SCHEMA, MAPPING_SCHEMA } from '@/server/services/mapping/schema'
import { expandQuery } from '@/server/services/terminology/dictionary'
import { lexicalScore, tokens, type TerminologySearch } from '@/server/services/terminology/search'
import { LlmSchemaError, type LLMClient } from '@/types/llm'

const span = { page: 1, block_ids: ['b1'], quote: 'metformin 500 mg', char_start: 0, char_end: 16 }
const stored = (field_key: string, value: string): StoredField => ({ field_key, found: true, value, source_span: span, basis: 'stated', model_confidence: 0.9 })

const item = (overrides: Partial<MappingItem> = {}): MappingItem => ({
  fieldKey: 'medication[0].name',
  text: 'Metformin',
  context: 'metformin 500 mg',
  resourceType: 'MedicationRequest',
  system: 'snomed',
  secondary: false,
  candidates: [
    { id: 'c1', system: 'snomed', code: '372567009', display: 'Metformin', score: 0.95 },
    { id: 'c2', system: 'snomed', code: '108', display: 'Metformin hydrochloride', score: 0.8 },
  ],
  ...overrides,
})

const llmReturning = (choices: unknown[]): LLMClient => ({
  complete: vi.fn(async () => ({ output: { choices }, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.01, latencyMs: 1, model: 'm' })) as never,
})
const options = (llm: LLMClient) => ({ llm, model: 'm', system: 's', recordId: 'r', maxTokens: 100, timeoutMs: 100 })

describe('lexical scoring', () => {
  it('ignores short and filler words', () => {
    expect(tokens('Tablet of Metformin 500 mg')).toEqual(['metformin', '500'])
  })

  it('scores an exact name above a partial one, and unrelated text at zero', () => {
    expect(lexicalScore('metformin', 'Metformin', [])).toBeGreaterThan(lexicalScore('metformin', 'Metformin and glipizide combination', []))
    expect(lexicalScore('metformin', 'Insulin', [])).toBe(0)
  })

  it('scores an exact name or synonym as certain, even for short forms', () => {
    expect(lexicalScore('AF', 'Atrial fibrillation', ['af', 'afib'])).toBe(1)
    expect(lexicalScore(' Heart Attack ', 'Myocardial infarction', ['heart attack'])).toBe(1)
    expect(lexicalScore('MI', 'Metformin', [])).toBe(0)
  })

  it('uses synonyms', () => {
    expect(lexicalScore('heart attack', 'Myocardial infarction', ['Heart attack'])).toBeGreaterThan(0.8)
  })
})

describe('expandQuery', () => {
  it('adds the dictionary expansion beside the original text', () => {
    expect(expandQuery('Crocin', new Map([['crocin', 'paracetamol']]))).toEqual(['Crocin', 'paracetamol'])
    expect(expandQuery('Aspirin', new Map())).toEqual(['Aspirin'])
  })
})

describe('verifyChoice', () => {
  it('accepts a listed candidate and stores the top candidates', () => {
    const { coding } = verifyChoice(item(), { field_key: 'medication[0].name', candidate_id: 'c1', match_confidence: 0.9, rationale: '' })
    expect(coding).toMatchObject({ system: 'snomed', code: '372567009', match_confidence: 0.9 })
    expect(coding?.candidates).toHaveLength(2)
  })

  it('rejects an id that was not offered and reports it as invalid', () => {
    expect(verifyChoice(item(), { field_key: 'x', candidate_id: 'c9', match_confidence: 0.9, rationale: '' })).toEqual({ coding: null, invalid: true })
  })

  it('treats null, a missing answer and low confidence as no match', () => {
    expect(verifyChoice(item(), { field_key: 'x', candidate_id: null, match_confidence: 0.9, rationale: '' })).toEqual({ coding: null, invalid: false })
    expect(verifyChoice(item(), undefined)).toEqual({ coding: null, invalid: false })
    expect(verifyChoice(item(), { field_key: 'x', candidate_id: 'c1', match_confidence: 0.2, rationale: '' })).toEqual({ coding: null, invalid: false })
  })
})

describe('mapCodes', () => {
  it('applies verified choices, tracks rejected ones and sums usage', async () => {
    const items = [item(), item({ fieldKey: 'medication[1].name' })]
    const llm = llmReturning([
      { field_key: 'medication[0].name', candidate_id: 'c1', match_confidence: 0.9, rationale: '' },
      { field_key: 'medication[1].name', candidate_id: 'nope', match_confidence: 0.9, rationale: '' },
    ])
    const result = await mapCodes(items, options(llm))
    expect([...result.codings.keys()]).toEqual(['medication[0].name'])
    expect([...result.invalidSelections]).toEqual(['medication[1].name'])
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(result.costUsd).toBe(0.01)
  })

  it('drops a secondary code whose primary was not found', async () => {
    const items = [
      item({ fieldKey: 'diagnosis[0].text' }),
      item({ fieldKey: 'diagnosis[0].text#2', system: 'icd10', secondary: true, candidates: [{ id: 'c1', system: 'icd10', code: 'E11', display: 'T2DM', score: 0.9 }] }),
    ]
    const llm = llmReturning([
      { field_key: 'diagnosis[0].text', candidate_id: null, match_confidence: 0, rationale: '' },
      { field_key: 'diagnosis[0].text#2', candidate_id: 'c1', match_confidence: 0.9, rationale: '' },
    ])
    expect((await mapCodes(items, options(llm))).codings.size).toBe(0)
  })

  it('repairs one schema failure, then raises a retryable error on a second', async () => {
    const complete = vi.fn()
      .mockRejectedValueOnce(new LlmSchemaError('bad'))
      .mockResolvedValueOnce({ output: { choices: [] }, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: null, latencyMs: 1, model: 'm' })
    await expect(mapCodes([item()], options({ complete } as never))).resolves.toBeTruthy()
    expect(complete).toHaveBeenCalledTimes(2)

    const failing = { complete: vi.fn().mockRejectedValue(new LlmSchemaError('bad')) }
    await expect(mapCodes([item()], options(failing as never))).rejects.toMatchObject({ retryable: true })
  })

  it('batches at most 40 items per call', async () => {
    const items = Array.from({ length: 85 }, (_, index) => item({ fieldKey: `lab[${index}].test_name` }))
    const llm = llmReturning([])
    await mapCodes(items, options(llm))
    expect(llm.complete).toHaveBeenCalledTimes(3)
  })
})

describe('planMappingItems', () => {
  const search: TerminologySearch = {
    search: async (query, system) =>
      query.toLowerCase().includes('metformin') ? [{ system, code: system === 'snomed' ? '1' : '2', display: 'Metformin', score: 0.9 }] : [],
    exists: async () => true,
  }

  it('offers candidates for codeable fields and reports the ones with none', async () => {
    const instances = groupFields([stored('medication[0].name', 'Metformin'), stored('medication[1].name', 'Unknownium'), stored('diagnosis[0].text', 'Metformin overdose')])
    const { items, withoutCandidates } = await planMappingItems(instances, search, new Map())
    expect(items.map((entry) => entry.fieldKey).sort()).toEqual(['diagnosis[0].text', 'diagnosis[0].text#2', 'medication[0].name'])
    expect(withoutCandidates).toEqual(['medication[1].name'])
    expect(items.find((entry) => entry.fieldKey === 'medication[0].name')?.candidates[0]?.id).toBe('c1')
  })

  it('searches the dictionary expansion too', async () => {
    const { items } = await planMappingItems(groupFields([stored('medication[0].name', 'Glucophage')]), search, new Map([['glucophage', 'metformin']]))
    expect(items).toHaveLength(1)
  })
})

describe('mapping schema', () => {
  it('keeps the strict JSON schema in step with the validator', () => {
    const itemSchema = (MAPPING_JSON_SCHEMA.properties as any).choices.items
    expect(itemSchema.additionalProperties).toBe(false)
    expect(itemSchema.required).toEqual(Object.keys(itemSchema.properties))
    expect(itemSchema.required).toEqual(['field_key', 'candidate_id', 'match_confidence', 'rationale'])
  })

  it('clamps confidence and cuts a long rationale, but rejects a malformed answer', () => {
    const parsed = MAPPING_SCHEMA.parse({ choices: [{ field_key: 'a', candidate_id: null, match_confidence: 2, rationale: 'x'.repeat(400) }] })
    expect(parsed.choices[0]).toMatchObject({ match_confidence: 1 })
    expect(parsed.choices[0]?.rationale).toHaveLength(300)
    expect(() => MAPPING_SCHEMA.parse({ choices: [{ field_key: 'a', candidate_id: 5, match_confidence: 0.5, rationale: '' }] })).toThrow(LlmSchemaError)
    expect(MAPPING_SCHEMA.parse({ choices: [] })).toEqual({ choices: [] })
  })
})
