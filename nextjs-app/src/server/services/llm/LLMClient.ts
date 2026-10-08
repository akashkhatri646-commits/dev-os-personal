import 'server-only'
import { getEnv } from '@/server/config/env'
import { createOpenAiClient, type ModelPrice } from '@/server/services/llm/openai'
import { providerConfigFromEnv } from '@/server/services/llm/providerConfig'
import type { LLMClient } from '@/types/llm'

export type { LLMClient, LlmRequest, LlmResponse, LlmSchema } from '@/types/llm'
export { LlmSchemaError } from '@/types/llm'

let cached: { key: string; client: LLMClient } | null = null

/** Prices are set for the extraction model only (LLM_PRICE_*); any other model reports no cost. */
function pricesFromEnv(): Record<string, ModelPrice> {
  const env = getEnv()
  if (!env.LLM_MODEL_EXTRACTION || env.LLM_PRICE_INPUT_PER_MTOK === undefined || env.LLM_PRICE_OUTPUT_PER_MTOK === undefined) return {}
  return { [env.LLM_MODEL_EXTRACTION]: { input: env.LLM_PRICE_INPUT_PER_MTOK, output: env.LLM_PRICE_OUTPUT_PER_MTOK } }
}

/**
 * The model provider selected by LLM_PROVIDER (OpenAI, or Azure OpenAI for in-region data), or `null`
 * when none is configured: the stages then hold records for review as `llm_unavailable` instead of
 * guessing. A selected provider that is missing its key or endpoint throws a final error that names
 * the missing variables.
 */
export function getLlmClient(provider: 'openai' | 'azure_openai' | undefined = getEnv().LLM_PROVIDER): LLMClient | null {
  if (!provider) return null
  const config = providerConfigFromEnv(provider)
  const env = getEnv()
  const key = JSON.stringify([config.provider, config.endpoint, config.apiVersion, config.apiKey.slice(-6), env.LLM_MODEL_EXTRACTION, env.LLM_PRICE_INPUT_PER_MTOK, env.LLM_PRICE_OUTPUT_PER_MTOK, env.LLM_MAX_INPUT_TOKENS])
  if (cached?.key === key) return cached.client
  const client = createOpenAiClient({ ...config, prices: pricesFromEnv(), maxInputTokens: env.LLM_MAX_INPUT_TOKENS })
  cached = { key, client }
  return client
}
