import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@/lib/api/errors'
import { DISCHARGE_SUMMARY_CATALOG } from '@/server/services/extraction/fieldCatalog'
import {
  CHUNK_OVERLAP_PAGES,
  MAX_PAGES_PER_CHUNK,
  extractChunk,
  mergeExtractions,
  planChunks,
  runExtraction,
} from '@/server/services/extraction/extract'
import { BUILTIN_EXTRACTION_PROMPT } from '@/server/services/extraction/prompt'
import type { RawExtraction, RawExtractionField } from '@/server/services/extraction/schema'
import { RecordingLLMClient, ReplayLLMClient, requestKey } from '@/server/services/llm/replay'
import { LlmSchemaError, type LLMClient, type LlmRequest, type LlmResponse } from '@/types/llm'
import type { OcrPage } from '@/types/ocr'

const makePage = (pageNumber: number, lines: string[]): OcrPage => ({
  page: pageNumber,
  text: lines.join('\n'),
  confidence: 1,
  blocks: lines.map((text, index) => ({ id: `p${pageNumber}b${index + 1}`, text })),
})

const found = (key: string, value: string, quote: string, page: number, block: string): RawExtractionField => ({
  field_key: key,
  value,
  found: true,
  basis: 'stated',
  confidence: 0.95,
  source: { page, block_ids: [block], quote },
})

const medication = (index: number, name: string, line: string, page: number, block: string): RawExtractionField[] => [
  found(`medication[${index}].name`, name, line, page, block),
  found(`medication[${index}].dose_value`, '500', line, page, block),
  found(`medication[${index}].dose_unit`, 'mg', line, page, block),
  found(`medication[${index}].frequency`, 'twice daily', line, page, block),
]

const LINE = 'Tab Metformin 500 mg BD x 30 days'
const PAGES = [makePage(1, ['DISCHARGE SUMMARY', LINE])]
const answer = (fields: RawExtractionField[]): RawExtraction => ({ fields, document_notes: '' })

const usage = { inputTokens: 1000, outputTokens: 200 }

function scripted(outputs: (RawExtraction | Error)[]): { client: LLMClient; calls: LlmRequest<unknown>[] } {
  const calls: LlmRequest<unknown>[] = []
  const queue = [...outputs]
  const client: LLMClient = {
    async complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
      calls.push(request as LlmRequest<unknown>)
      const next = queue.shift()
      if (!next) throw new Error('script exhausted')
      if (next instanceof Error) throw next
      return { output: next as unknown as T, usage, costUsd: 0.01, latencyMs: 5, model: request.model }
    },
  }
  return { client, calls }
}

const baseOptions = (client: LLMClient, pages = PAGES) => ({
  llm: client,
  model: 'test-model',
  system: BUILTIN_EXTRACTION_PROMPT.template,
  fewShot: BUILTIN_EXTRACTION_PROMPT.few_shot,
  pages,
  recordId: 'rec-1',
  maxTokens: 4000,
  timeoutMs: 30_000,
})

describe('planChunks', () => {
  const pages = (count: number) => Array.from({ length: count }, (_, index) => makePage(index + 1, ['x']))

  it('keeps a short document whole', () => {
    expect(planChunks(pages(3))).toHaveLength(1)
    expect(planChunks(pages(MAX_PAGES_PER_CHUNK))).toHaveLength(1)
  })

  it('splits a long document into overlapping groups that cover every page', () => {
    const chunks = planChunks(pages(20))
    expect(chunks.every((chunk) => chunk.length <= MAX_PAGES_PER_CHUNK)).toBe(true)
    const covered = new Set(chunks.flatMap((chunk) => chunk.map((page) => page.page)))
    expect(covered.size).toBe(20)
    // Neighbouring chunks share the overlap pages.
    const firstEnd = chunks[0]?.slice(-CHUNK_OVERLAP_PAGES).map((page) => page.page)
    const secondStart = chunks[1]?.slice(0, CHUNK_OVERLAP_PAGES).map((page) => page.page)
    expect(firstEnd).toEqual(secondStart)
  })

  it('does not create a trailing chunk that adds no new page', () => {
    const chunks = planChunks(pages(MAX_PAGES_PER_CHUNK + 1))
    expect(chunks).toHaveLength(2)
    expect(chunks[1]?.map((page) => page.page)).toEqual([MAX_PAGES_PER_CHUNK, MAX_PAGES_PER_CHUNK + 1])
  })
})

describe('extractChunk: repair once, then give up', () => {
  it('returns the first valid answer with its usage and cost', async () => {
    const { client, calls } = scripted([answer(medication(0, 'Metformin', LINE, 1, 'p1b2'))])
    const result = await extractChunk(baseOptions(client))
    expect(result.extraction.fields).toHaveLength(4)
    expect(result.usage).toEqual(usage)
    expect(result.costUsd).toBe(0.01)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.component).toBe('extraction')
    expect(calls[0]?.schema.name).toBe('record_extraction')
  })

  it('makes exactly one repair call quoting the validation problems, and adds up usage', async () => {
    const { client, calls } = scripted([new LlmSchemaError('fields.0.source: A found field must cite its source'), answer([])])
    const result = await extractChunk(baseOptions(client))
    expect(calls).toHaveLength(2)
    const repair = calls[1]?.messages[calls[1].messages.length - 1]
    expect(String(repair?.content)).toContain('fields.0.source')
    expect(result.extraction.fields).toEqual([])
  })

  it('throws a retryable upstream error when the repair is invalid too', async () => {
    const { client, calls } = scripted([new LlmSchemaError('bad'), new LlmSchemaError('still bad')])
    await expect(extractChunk(baseOptions(client))).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true })
    expect(calls).toHaveLength(2)
  })

  it('does not repair on provider errors: they propagate to the worker retry', async () => {
    const { client, calls } = scripted([new AppError('UPSTREAM_ERROR', 'rate limited', { retryable: true })])
    await expect(extractChunk(baseOptions(client))).rejects.toMatchObject({ message: 'rate limited' })
    expect(calls).toHaveLength(1)
  })

  it('sends the worked examples before the document', async () => {
    const { client, calls } = scripted([answer([])])
    await extractChunk(baseOptions(client))
    const messages = calls[0]?.messages ?? []
    expect(messages.length).toBe(BUILTIN_EXTRACTION_PROMPT.few_shot.length * 2 + 1)
    expect(String(messages[messages.length - 1]?.content)).toContain('[p1b2] Tab Metformin')
  })
})

describe('mergeExtractions', () => {
  it('renumbers each chunk so entities from different chunks never collide', () => {
    const merged = mergeExtractions(
      [
        answer(medication(0, 'Metformin', LINE, 1, 'p1b2')),
        answer(medication(0, 'Pantop', 'Tab Pantop 40 mg OD', 2, 'p2b1')),
      ],
      DISCHARGE_SUMMARY_CATALOG,
    )
    const names = merged.fields.filter((field) => field.field_key.endsWith('.name'))
    expect(names.map((field) => field.field_key).sort()).toEqual(['medication[0].name', 'medication[1].name'])
    expect(new Set(names.map((field) => field.value))).toEqual(new Set(['Metformin', 'Pantop']))
  })

  it('keeps a medication repeated in an overlap page once, preferring the fuller answer', () => {
    const partial = answer([found('medication[0].name', 'Metformin', LINE, 1, 'p1b2')])
    const full = answer(medication(0, 'metformin', LINE, 2, 'p2b1'))
    const merged = mergeExtractions([partial, full], DISCHARGE_SUMMARY_CATALOG)
    expect(merged.fields.filter((field) => field.field_key.endsWith('.name'))).toHaveLength(1)
    expect(merged.fields).toHaveLength(4)
  })

  it('merges across different entity types independently and keeps singleton entities unnumbered', () => {
    const merged = mergeExtractions(
      [
        answer([found('encounter.admission_date', '2026-09-16', '16/09/2026', 1, 'p1b1')]),
        answer([found('diagnosis[0].text', 'Pneumonia', 'Pneumonia', 2, 'p2b1')]),
      ],
      DISCHARGE_SUMMARY_CATALOG,
    )
    expect(merged.fields.map((field) => field.field_key).sort()).toEqual(['diagnosis[0].text', 'encounter.admission_date'])
  })

  it('passes unknown keys through so grounding can report them, and joins the notes', () => {
    const merged = mergeExtractions(
      [{ fields: [found('ghost[0].x', 'y', 'q', 1, 'p1b1')], document_notes: 'first' }, { fields: [], document_notes: 'second' }],
      DISCHARGE_SUMMARY_CATALOG,
    )
    expect(merged.fields[0]?.field_key).toBe('ghost[0].x')
    expect(merged.document_notes).toBe('first second')
  })
})

describe('runExtraction (offline, deterministic)', () => {
  it('chunks, calls, merges and grounds end to end', async () => {
    const pages = Array.from({ length: 12 }, (_, index) =>
      makePage(index + 1, index === 0 ? ['DISCHARGE SUMMARY', LINE] : index === 10 ? ['Tab Pantop 40 mg OD'] : ['Narrative text']),
    )
    const first = answer(medication(0, 'Metformin', LINE, 1, 'p1b2'))
    const second = answer([
      found('medication[0].name', 'Pantop', 'Tab Pantop 40 mg OD', 11, 'p11b1'),
      found('medication[0].dose_value', '40', 'Tab Pantop 40 mg OD', 11, 'p11b1'),
    ])
    const { client, calls } = scripted([first, second])

    const run = await runExtraction({ ...baseOptions(client, pages), pages, catalog: DISCHARGE_SUMMARY_CATALOG })

    expect(run.chunks).toBe(2)
    expect(calls).toHaveLength(2)
    expect(run.usage).toEqual({ inputTokens: 2000, outputTokens: 400 })
    expect(run.costUsd).toBeCloseTo(0.02, 10)
    const names = run.report.fields.filter((field) => field.field_key.endsWith('.name')).map((field) => field.value)
    expect(names).toEqual(['Metformin', 'Pantop'])
    expect(run.report.fields.find((field) => field.field_key === 'medication[1].dose_unit')).toMatchObject({ found: false })
  })

  it('removes hallucinated values even though the model reported them with confidence', async () => {
    const hallucinated = answer([
      ...medication(0, 'Metformin', LINE, 1, 'p1b2').slice(0, 2),
      found('medication[0].dose_unit', 'g', LINE, 1, 'p1b2'),
      found('medication[0].frequency', 'four times daily', LINE, 1, 'p1b2'),
    ])
    const { client } = scripted([hallucinated])
    const run = await runExtraction({ ...baseOptions(client), catalog: DISCHARGE_SUMMARY_CATALOG })
    expect(run.report.fields.find((field) => field.field_key === 'medication[0].dose_unit')?.found).toBe(false)
    expect(run.report.fields.find((field) => field.field_key === 'medication[0].frequency')?.found).toBe(false)
    expect(run.report.fields.find((field) => field.field_key === 'medication[0].dose_value')?.value).toBe(500)
  })
})

describe('record and replay (fixtures for evals and tests)', () => {
  const request = (document: string) => ({
    component: 'extraction' as const,
    model: 'test-model',
    system: 'sys',
    schema: { name: 'record_extraction' },
    messages: [{ role: 'user' as const, content: document }],
  })

  it('keys requests by everything that shapes the answer', () => {
    const base = requestKey(request('doc A'))
    expect(requestKey(request('doc A'))).toBe(base)
    expect(requestKey(request('doc B'))).not.toBe(base)
    expect(requestKey({ ...request('doc A'), model: 'other-model' })).not.toBe(base)
    expect(requestKey({ ...request('doc A'), system: 'other system' })).not.toBe(base)
    expect(requestKey({ ...request('doc A'), schema: { name: 'other' } })).not.toBe(base)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hashes images instead of embedding them in the key', () => {
    const withImage = (byte: number) => ({
      ...request('x'),
      messages: [{ role: 'user' as const, content: [{ type: 'image' as const, mediaType: 'image/png', data: Buffer.from([byte]) }] }],
    })
    expect(requestKey(withImage(1))).not.toBe(requestKey(withImage(2)))
    expect(requestKey(withImage(1))).toBe(requestKey(withImage(1)))
  })

  it('records a live run, then replays it offline with no provider and identical results', async () => {
    const { client } = scripted([answer(medication(0, 'Metformin', LINE, 1, 'p1b2'))])
    const recorder = new RecordingLLMClient(client)
    const live = await runExtraction({ ...baseOptions(recorder), catalog: DISCHARGE_SUMMARY_CATALOG })
    expect(Object.keys(recorder.recorded)).toHaveLength(1)

    const replay = new ReplayLLMClient(recorder.recorded)
    const offline = await runExtraction({ ...baseOptions(replay), catalog: DISCHARGE_SUMMARY_CATALOG })
    expect(offline.report).toEqual(live.report)
  })

  it('fails loudly, never guesses, for a request that was not recorded', async () => {
    const replay = new ReplayLLMClient({})
    const attempt = runExtraction({ ...baseOptions(replay), catalog: DISCHARGE_SUMMARY_CATALOG })
    await expect(attempt).rejects.toMatchObject({ reason: 'REPLAY_MISS', retryable: false })
  })

  it('rejects a stale fixture that no longer matches the schema', async () => {
    const { client } = scripted([answer([])])
    const recorder = new RecordingLLMClient(client)
    await runExtraction({ ...baseOptions(recorder), catalog: DISCHARGE_SUMMARY_CATALOG })
    const [key] = Object.keys(recorder.recorded)
    const corrupted = { [key as string]: { ...recorder.recorded[key as string]!, output: { fields: 'broken' } } }
    const spy = vi.fn()
    await expect(
      runExtraction({ ...baseOptions(new ReplayLLMClient(corrupted)), catalog: DISCHARGE_SUMMARY_CATALOG }).catch((error: unknown) => {
        spy(error)
        throw error
      }),
    ).rejects.toBeTruthy()
    expect(spy).toHaveBeenCalled()
  })
})
