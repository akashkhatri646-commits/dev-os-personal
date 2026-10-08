import { AppError } from '@/lib/api/errors'
import { getEnv } from '@/server/config/env'
import type { ProviderConfig } from '@/server/services/llm/openaiHttp'

/**
 * The provider settings from the environment. A provider that is selected but not fully configured is
 * a final error naming the missing variables, so a record is held for review with a clear reason
 * instead of being retried against a misconfigured endpoint.
 */
export function providerConfigFromEnv(provider: 'openai' | 'azure_openai'): ProviderConfig {
  const env = getEnv()
  const missing: string[] = []
  if (provider === 'openai') {
    if (!env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY')
    if (missing.length === 0) return { provider, apiKey: env.OPENAI_API_KEY as string }
  } else {
    if (!env.AZURE_OPENAI_ENDPOINT) missing.push('AZURE_OPENAI_ENDPOINT')
    if (!env.AZURE_OPENAI_API_KEY) missing.push('AZURE_OPENAI_API_KEY')
    if (!env.AZURE_OPENAI_API_VERSION) missing.push('AZURE_OPENAI_API_VERSION')
    if (missing.length === 0) {
      return { provider, apiKey: env.AZURE_OPENAI_API_KEY as string, endpoint: env.AZURE_OPENAI_ENDPOINT as string, apiVersion: env.AZURE_OPENAI_API_VERSION as string }
    }
  }
  throw new AppError('INTERNAL', `The ${provider} provider is not configured: set ${missing.join(', ')}.`, { retryable: false, reason: 'LLM_NOT_CONFIGURED' })
}
