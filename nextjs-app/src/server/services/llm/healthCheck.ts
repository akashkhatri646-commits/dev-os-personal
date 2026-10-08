import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getEnv } from '@/server/config/env'
import { getLlmClient } from '@/server/services/llm/LLMClient'
import { getEmbeddingsClient } from '@/server/services/terminology/search'
import { LlmSchemaError, type LlmSchema } from '@/types/llm'

export interface ModelCheck {
  name: string
  ok: boolean
  model: string | null
  latency_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  /** What went wrong, in words an admin can act on. Never includes anything sent to the model. */
  problem: string | null
}

export interface ModelCheckResult {
  provider: 'openai' | 'azure_openai' | null
  ok: boolean
  checks: ModelCheck[]
}

/** A tiny strict-schema request: proves the key, the model name and structured outputs all work. */
const PING_SCHEMA: LlmSchema<{ ok: boolean; word: string }> = {
  name: 'connection_check',
  jsonSchema: { type: 'object', additionalProperties: false, required: ['ok', 'word'], properties: { ok: { type: 'boolean' }, word: { type: 'string' } } },
  parse(raw) {
    const value = raw as { ok?: unknown; word?: unknown }
    if (typeof value?.ok !== 'boolean' || typeof value?.word !== 'string') throw new LlmSchemaError('expected {ok, word}')
    return { ok: value.ok, word: value.word }
  },
}

const failed = (name: string, model: string | null, problem: string): ModelCheck => ({ name, ok: false, model, latency_ms: null, input_tokens: null, output_tokens: null, cost_usd: null, problem })

const describeError = (error: unknown): string => (error instanceof AppError || error instanceof LlmSchemaError ? error.message : 'The call failed.')

/**
 * Calls the configured provider with synthetic text (no patient data) and reports, for each model in
 * use and for embeddings, whether it works. Provider failures are reported, not thrown, so an admin
 * can see exactly which setting is wrong.
 */
export async function checkModelConnection(): Promise<ModelCheckResult> {
  const env = getEnv()
  const provider = env.LLM_PROVIDER ?? null
  if (!provider) return { provider: null, ok: false, checks: [failed('provider', null, 'LLM_PROVIDER is not set.')] }

  const checks: ModelCheck[] = []
  let client: ReturnType<typeof getLlmClient>
  try {
    client = getLlmClient(provider)
  } catch (error) {
    return { provider, ok: false, checks: [failed('provider', null, describeError(error))] }
  }

  const models = [...new Set([env.LLM_MODEL_EXTRACTION, env.LLM_MODEL_LIGHT].filter((model): model is string => Boolean(model)))]
  if (models.length === 0) checks.push(failed('model', null, 'LLM_MODEL_EXTRACTION is not set.'))
  for (const model of models) {
    try {
      const response = await client!.complete({
        component: 'extraction',
        model,
        system: 'You answer with the JSON the schema asks for.',
        messages: [{ role: 'user', content: 'Return ok true and the word "ping".' }],
        schema: PING_SCHEMA,
        maxTokens: 50,
        timeoutMs: Math.min(env.LLM_REQUEST_TIMEOUT_MS, 30_000),
        recordId: 'connection-check',
      })
      checks.push({ name: `model ${model}`, ok: response.output.ok === true, model, latency_ms: response.latencyMs, input_tokens: response.usage.inputTokens, output_tokens: response.usage.outputTokens, cost_usd: response.costUsd, problem: response.output.ok ? null : 'The model answered, but not as asked.' })
    } catch (error) {
      checks.push(failed(`model ${model}`, model, describeError(error)))
    }
  }

  if (env.EMBEDDINGS_MODEL) {
    const embeddings = getEmbeddingsClient()
    if (!embeddings) checks.push(failed('embeddings', env.EMBEDDINGS_MODEL, 'Embeddings are not configured for this provider.'))
    else {
      const started = Date.now()
      try {
        await embeddings.embed('metformin')
        checks.push({ name: `embeddings ${env.EMBEDDINGS_MODEL}`, ok: true, model: env.EMBEDDINGS_MODEL, latency_ms: Date.now() - started, input_tokens: null, output_tokens: null, cost_usd: null, problem: null })
      } catch (error) {
        checks.push(failed(`embeddings ${env.EMBEDDINGS_MODEL}`, env.EMBEDDINGS_MODEL, describeError(error)))
      }
    }
  }
  return { provider, ok: checks.every((check) => check.ok), checks }
}
