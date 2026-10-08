import { beforeEach, describe, expect, it, vi } from 'vitest'

const { logs } = vi.hoisted(() => ({ logs: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/server/logger', () => ({ logger: logs }))

import { AppError } from '@/lib/api/errors'
import { costOf, createOpenAiClient, estimateInputTokens } from '@/server/services/llm/openai'
import { createOpenAiEmbeddings, EMBEDDING_DIMENSIONS } from '@/server/services/llm/openaiEmbeddings'
import { buildTarget, classifyFailure } from '@/server/services/llm/openaiHttp'
import { extractChunk } from '@/server/services/extraction/extract'
import { EXTRACTION_SCHEMA } from '@/server/services/extraction/schema'
import { MAPPING_SCHEMA } from '@/server/services/mapping/schema'
import { textToPages } from '@/server/services/normalization/textDocument'
import { LlmSchemaError, type LlmRequest, type LlmSchema } from '@/types/llm'
import { DISCHARGE_FIELDS, DISCHARGE_TEXT, extractionFor } from '../support/fixtures'

const SCHEMA: LlmSchema<{ answer: string }> = {
  name: 'test_answer',
  jsonSchema: { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } },
  parse(raw) {
    if (typeof (raw as { answer?: unknown })?.answer !== 'string') throw new LlmSchemaError('answer: expected string')
    return { answer: (raw as { answer: string }).answer }
  },
}

const request = (overrides: Partial<LlmRequest<{ answer: string }>> = {}): LlmRequest<{ answer: string }> => ({
  component: 'extraction',
  model: 'gpt-test',
  system: 'You are a careful reader.',
  messages: [{ role: 'user', content: 'Read this document.' }],
  schema: SCHEMA,
  maxTokens: 500,
  timeoutMs: 5000,
  recordId: 'rec-1',
  ...overrides,
})

const completion = (content: unknown, extra: Record<string, unknown> = {}) => ({
  choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop', ...extra }],
  usage: { prompt_tokens: 1000, completion_tokens: 200 },
})

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const fetchMock = vi.fn()
const openai = (overrides = {}) => createOpenAiClient({ provider: 'openai', apiKey: 'sk-test-key', prices: { 'gpt-test': { input: 2, output: 8 } }, fetch: fetchMock, ...overrides })
const azure = () => createOpenAiClient({ provider: 'azure_openai', apiKey: 'az-key', endpoint: 'https://res.openai.azure.com/', apiVersion: '2024-10-21', fetch: fetchMock })

const sent = () => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) }
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(reply(200, completion({ answer: 'ok' })))
})

describe('request shape', () => {
  it('sends a strict structured-output request at temperature 0, with the key in a bearer header', async () => {
    await openai().complete(request())
    const { url, headers, body } = sent()
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(headers.authorization).toBe('Bearer sk-test-key')
    expect(body).toMatchObject({
      model: 'gpt-test',
      temperature: 0,
      max_completion_tokens: 500,
      response_format: { type: 'json_schema', json_schema: { name: 'test_answer', strict: true, schema: SCHEMA.jsonSchema } },
    })
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a careful reader.' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Read this document.' })
  })

  it('addresses an Azure deployment by URL, with the key in the api-key header and no model in the body', async () => {
    await azure().complete(request({ model: 'my-deployment' }))
    const { url, headers, body } = sent()
    expect(url).toBe('https://res.openai.azure.com/openai/deployments/my-deployment/chat/completions?api-version=2024-10-21')
    expect(headers['api-key']).toBe('az-key')
    expect(headers.authorization).toBeUndefined()
    expect(body.model).toBeUndefined()
    expect(body.response_format.json_schema.strict).toBe(true)
  })

  it('sends page images as data URLs next to the text', async () => {
    await openai().complete(request({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Page 1' }, { type: 'image', mediaType: 'image/png', data: Buffer.from('png-bytes') }] }] }))
    expect(sent().body.messages[1].content).toEqual([
      { type: 'text', text: 'Page 1' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}` } },
    ])
  })

  it('passes the project schemas to the provider unchanged', async () => {
    fetchMock.mockResolvedValue(reply(200, completion({ choices: [] })))
    await openai().complete({ ...request(), schema: MAPPING_SCHEMA as never })
    expect(sent().body.response_format.json_schema.schema).toEqual(MAPPING_SCHEMA.jsonSchema)
    fetchMock.mockResolvedValue(reply(200, completion({ fields: [], document_notes: '' })))
    await openai().complete({ ...request(), schema: EXTRACTION_SCHEMA as never })
    expect(sent().body.response_format.json_schema.schema).toEqual(EXTRACTION_SCHEMA.jsonSchema)
  })

  it('builds the endpoint for each provider and call kind', () => {
    expect(buildTarget({ provider: 'openai', apiKey: 'k' }, 'embeddings', 'm').url).toBe('https://api.openai.com/v1/embeddings')
    expect(buildTarget({ provider: 'azure_openai', apiKey: 'k', endpoint: 'https://r.openai.azure.com', apiVersion: 'v1' }, 'embeddings', 'emb 1').url).toBe('https://r.openai.azure.com/openai/deployments/emb%201/embeddings?api-version=v1')
  })
})

describe('results', () => {
  it('returns the validated answer with token usage, cost and latency', async () => {
    const result = await openai().complete(request())
    expect(result.output).toEqual({ answer: 'ok' })
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 200 })
    // 1000 × $2 + 200 × $8 per million
    expect(result.costUsd).toBeCloseTo(0.0036, 6)
    expect(result.model).toBe('gpt-test')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('reports no cost for a model without a configured price', async () => {
    expect((await openai().complete(request({ model: 'unpriced' }))).costUsd).toBeNull()
    expect(costOf(undefined, 10, 10)).toBeNull()
  })

  it('turns an unusable answer into a schema error the caller can repair: refusal, cut off, empty, not JSON, wrong shape', async () => {
    const cases: [unknown, RegExp][] = [
      [{ choices: [{ message: { content: null, refusal: 'I cannot help with that.' }, finish_reason: 'stop' }], usage: {} }, /refused/],
      [completion('{"answer":"par', { finish_reason: 'length' }), /cut off/],
      [completion(''), /empty/],
      [completion('not json at all'), /not valid JSON/],
      [completion({ answer: 42 }), /answer: expected string/],
      [{ choices: [], usage: {} }, /empty/],
    ]
    for (const [body, pattern] of cases) {
      fetchMock.mockResolvedValueOnce(reply(200, body))
      const error = await openai().complete(request()).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(LlmSchemaError)
      expect((error as LlmSchemaError).detail).toMatch(pattern)
    }
  })
})

describe('failures', () => {
  const failWith = async (status: number, body: unknown = { error: { message: 'boom' } }, headers: Record<string, string> = {}) => {
    fetchMock.mockResolvedValueOnce(reply(status, body, headers))
    return (await openai().complete(request()).catch((caught: unknown) => caught)) as AppError
  }

  it('treats rate limits and server errors as transient: retryable upstream errors, honouring Retry-After', async () => {
    const limited = await failWith(429, { error: { message: 'slow down' } }, { 'retry-after': '7' })
    expect(limited).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true, retryAfterSeconds: 7 })
    for (const status of [500, 502, 503, 408]) expect(await failWith(status)).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true })
    expect((await failWith(429, {}, { 'retry-after': '99999' })).retryAfterSeconds).toBe(120)
  })

  it('treats a timeout and a network failure as transient', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    fetchMock.mockRejectedValueOnce(timeout)
    expect(await openai().complete(request()).catch((caught: unknown) => caught)).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true, message: expect.stringContaining('in time') })
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await openai().complete(request()).catch((caught: unknown) => caught)).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true })
  })

  it('treats bad credentials and rejected requests as final, with a reason', async () => {
    expect(await failWith(401)).toMatchObject({ code: 'INTERNAL', retryable: false, reason: 'LLM_CREDENTIALS' })
    expect(await failWith(403)).toMatchObject({ retryable: false, reason: 'LLM_CREDENTIALS' })
    expect(await failWith(404, { error: { message: 'The model does not exist' } })).toMatchObject({ retryable: false, reason: 'LLM_BAD_REQUEST' })
    expect(await failWith(400, { error: { message: "This model's maximum context length is 128000 tokens" } })).toMatchObject({ retryable: false, reason: 'LLM_INPUT_TOO_LARGE' })
  })

  it('does not leak what was sent in any error', async () => {
    const error = await failWith(400, { error: { message: 'bad' } })
    expect(error.message).not.toContain('Read this document')
    expect(error.message).not.toContain('sk-test-key')
  })

  it('retries once without temperature for a model that only accepts its default, and remembers it', async () => {
    const client = openai()
    fetchMock.mockResolvedValueOnce(reply(400, { error: { message: "Unsupported value: 'temperature' does not support 0 with this model.", param: 'temperature', code: 'unsupported_value' } }))
    fetchMock.mockResolvedValueOnce(reply(200, completion({ answer: 'ok' })))
    expect((await client.complete(request())).output.answer).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)).temperature).toBe(0)
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)).temperature).toBeUndefined()

    await client.complete(request())
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body)).temperature).toBeUndefined()
  })

  it('classifies failures without a body', () => {
    expect(classifyFailure(500, null, new Headers()).kind).toBe('retryable')
    expect(classifyFailure(400, null, new Headers()).kind).toBe('bad_request')
  })
})

describe('guards and logging', () => {
  it('refuses an oversized request before calling the provider', async () => {
    const client = openai({ maxInputTokens: 1000 })
    const error = await client.complete(request({ messages: [{ role: 'user', content: 'x'.repeat(10_000) }] })).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ retryable: false, reason: 'LLM_INPUT_TOO_LARGE' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(estimateInputTokens({ system: '', messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: Buffer.from('x') }] }] })).toBe(1500)
  })

  it('logs which rules a rejected answer broke, without the answer itself', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, completion({ answer: 42 })))
    await openai().complete(request()).catch(() => undefined)
    const rejected = logs.warn.mock.calls.find(([fields]) => (fields as { schema_problem?: string }).schema_problem)
    expect((rejected?.[0] as { schema_problem: string }).schema_problem).toContain('answer: expected string')
    expect(JSON.stringify(rejected)).not.toContain('42')
  })

  it('logs only metadata: never the prompt, the document, the answer or the key', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, completion({ answer: 'secret clinical answer' })))
    await openai().complete(request({ messages: [{ role: 'user', content: 'Patient has diabetes' }] }))
    fetchMock.mockResolvedValueOnce(reply(500, { error: { message: 'internal error with detail' } }))
    await openai().complete(request()).catch(() => undefined)
    const logged = JSON.stringify([...logs.info.mock.calls, ...logs.warn.mock.calls])
    for (const secret of ['diabetes', 'secret clinical answer', 'sk-test-key', 'careful reader']) expect(logged).not.toContain(secret)
    expect(logged).toContain('input_tokens')
  })
})

describe('embeddings', () => {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => index / 1000)
  const embeddings = (provider: 'openai' | 'azure_openai' = 'openai') =>
    createOpenAiEmbeddings({ provider, apiKey: 'k', endpoint: 'https://r.openai.azure.com', apiVersion: 'v1', model: 'text-embedding-3-small', fetch: fetchMock })

  it('requests 1024 dimensions and returns the vector', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { data: [{ embedding: vector }] }))
    expect(await embeddings().embed('metformin')).toEqual(vector)
    expect(sent().body).toMatchObject({ model: 'text-embedding-3-small', input: 'metformin', dimensions: 1024 })
  })

  it('uses the deployment URL on Azure, and cuts very long input', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { data: [{ embedding: vector }] }))
    await embeddings('azure_openai').embed('a'.repeat(5000))
    expect(sent().url).toContain('/openai/deployments/text-embedding-3-small/embeddings')
    expect(sent().body.input).toHaveLength(2000)
    expect(sent().body.model).toBeUndefined()
  })

  it('fails with a final, explicit error when the vector is the wrong size, and with retryable errors for outages', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { data: [{ embedding: [0.1, 0.2] }] }))
    expect(await embeddings().embed('x').catch((caught: unknown) => caught)).toMatchObject({ retryable: false, reason: 'EMBEDDINGS_SHAPE' })
    fetchMock.mockResolvedValueOnce(reply(503, { error: { message: 'down' } }))
    expect(await embeddings().embed('x').catch((caught: unknown) => caught)).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true })
  })
})

describe('through the extraction code', () => {
  it('reads a document: the adapter returns the fixture answer in the strict schema and extraction accepts it', async () => {
    const pages = textToPages(DISCHARGE_TEXT)
    fetchMock.mockResolvedValueOnce(reply(200, completion(extractionFor(pages.map((page) => ({ page: page.page, blocks: page.blocks })), DISCHARGE_FIELDS))))
    const result = await extractChunk({ llm: openai({ prices: {} }), model: 'gpt-test', system: 'sys', fewShot: [], pages, recordId: 'rec-1', maxTokens: 4000, timeoutMs: 5000 })
    expect(result.extraction.fields).toHaveLength(DISCHARGE_FIELDS.length)
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 200 })
    expect(sent().body.response_format.json_schema.name).toBe('record_extraction')
    // The page text and block ids reach the model.
    expect(JSON.stringify(sent().body.messages)).toContain('p1b2')
  })

  it('repairs once after a malformed answer, then succeeds; after two it becomes a retryable error', async () => {
    const pages = textToPages(DISCHARGE_TEXT)
    const good = completion(extractionFor(pages.map((page) => ({ page: page.page, blocks: page.blocks })), DISCHARGE_FIELDS))
    fetchMock.mockResolvedValueOnce(reply(200, completion('not json'))).mockResolvedValueOnce(reply(200, good))
    const options = { llm: openai(), model: 'gpt-test', system: 'sys', fewShot: [], pages, recordId: 'rec-1', maxTokens: 4000, timeoutMs: 5000 }
    await expect(extractChunk(options)).resolves.toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(sent().body.messages)).toContain('failed validation')

    fetchMock.mockReset()
    fetchMock.mockResolvedValue(reply(200, completion('still not json')))
    await expect(extractChunk(options)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true })
  })
})
