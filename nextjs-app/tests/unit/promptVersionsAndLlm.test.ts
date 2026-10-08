import { beforeEach, describe, expect, it, vi } from 'vitest'

const { state, mocks } = vi.hoisted(() => ({
  state: {
    selects: [] as { data: unknown; error: { message: string } | null }[],
    insertError: null as { code?: string; message: string } | null,
  },
  mocks: { insert: vi.fn() },
}))

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: () => {
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'eq']) chain[method] = () => chain
      chain.maybeSingle = () => Promise.resolve(state.selects.shift() ?? { data: null, error: null })
      chain.insert = (values: unknown) => {
        mocks.insert(values)
        return Promise.resolve({ error: state.insertError })
      }
      return chain
    },
  }),
}))
vi.mock('@/server/config/env', () => ({ getEnv: () => ({ LLM_PROVIDER: undefined }) }))

import { AppError } from '@/lib/api/errors'
import { BUILTIN_EXTRACTION_PROMPT } from '@/server/services/extraction/prompt'
import { getLlmClient } from '@/server/services/llm/LLMClient'
import { getActiveExtractionPrompt } from '@/server/services/prompts/promptVersions'

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'pv-1',
  version: 'extraction-v1',
  template: 'system text',
  few_shot: [{ user: 'u', assistant: 'a' }],
  model_id: 'model-x',
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  state.selects = []
  state.insertError = null
})

describe('getActiveExtractionPrompt', () => {
  it('returns the active version without writing anything', async () => {
    state.selects = [{ data: row(), error: null }]
    const prompt = await getActiveExtractionPrompt('model-x')
    expect(prompt).toEqual({ id: 'pv-1', version: 'extraction-v1', template: 'system text', fewShot: [{ user: 'u', assistant: 'a' }], modelId: 'model-x' })
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('stores and activates the built-in version the first time', async () => {
    state.selects = [{ data: null, error: null }, { data: row({ id: 'pv-new' }), error: null }]
    const prompt = await getActiveExtractionPrompt('model-x')
    expect(prompt.id).toBe('pv-new')
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'extraction',
        version: BUILTIN_EXTRACTION_PROMPT.version,
        template: BUILTIN_EXTRACTION_PROMPT.template,
        few_shot: BUILTIN_EXTRACTION_PROMPT.few_shot,
        model_id: 'model-x',
        active: true,
      }),
    )
  })

  it('tolerates losing the race to another worker (unique violation) and uses the winner', async () => {
    state.selects = [{ data: null, error: null }, { data: row({ id: 'pv-winner' }), error: null }]
    state.insertError = { code: '23505', message: 'duplicate' }
    expect((await getActiveExtractionPrompt('model-x')).id).toBe('pv-winner')
  })

  it('throws a retryable error for any other write failure, or when nothing becomes active', async () => {
    state.selects = [{ data: null, error: null }]
    state.insertError = { message: 'db down' }
    await expect(getActiveExtractionPrompt('model-x')).rejects.toMatchObject({ retryable: true })

    state.selects = [{ data: null, error: null }, { data: null, error: null }]
    state.insertError = null
    await expect(getActiveExtractionPrompt('model-x')).rejects.toMatchObject({ retryable: true })
  })

  it('rejects a stored prompt whose few-shot data is malformed instead of using it', async () => {
    state.selects = [{ data: row({ few_shot: 'oops' }), error: null }]
    await expect(getActiveExtractionPrompt('model-x')).rejects.toBeTruthy()
  })
})

describe('getLlmClient', () => {
  it('returns null when no provider is configured', () => {
    expect(getLlmClient(undefined)).toBeNull()
  })

  it.each([
    ['openai', 'OPENAI_API_KEY'],
    ['azure_openai', 'AZURE_OPENAI_ENDPOINT'],
  ] as const)('fails closed with a non-retryable error naming the missing settings for %s', (provider, variable) => {
    let thrown: unknown
    try {
      getLlmClient(provider)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).retryable).toBe(false)
    expect((thrown as AppError).reason).toBe('LLM_NOT_CONFIGURED')
    expect((thrown as AppError).message).toContain(variable)
  })
})
