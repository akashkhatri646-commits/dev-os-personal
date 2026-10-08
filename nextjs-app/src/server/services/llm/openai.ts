import { AppError } from '@/lib/api/errors'
import { logger } from '@/server/logger'
import {
  buildTarget,
  classifyFailure,
  failureToError,
  postJson,
  type Fetch,
  type ProviderConfig,
} from '@/server/services/llm/openaiHttp'
import { LlmSchemaError, type LLMClient, type LlmMessage, type LlmRequest, type LlmResponse } from '@/types/llm'

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number
  /** USD per million output tokens. */
  output: number
}

export interface OpenAiClientConfig extends ProviderConfig {
  /** Prices by model id (Azure: deployment name). A model without one reports no cost. */
  prices?: Record<string, ModelPrice>
  /** Rough ceiling on input tokens per call, as a guard against a runaway prompt. */
  maxInputTokens?: number
  fetch?: Fetch
}

/** English clinical text averages a little under 4 characters per token; being low overestimates, which is the safe side. */
const CHARS_PER_TOKEN = 3
/** What an attached image is counted as when estimating input size. */
const IMAGE_TOKENS = 1500

type ChatContent = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[]

function toChatMessage(message: LlmMessage): { role: 'user' | 'assistant'; content: ChatContent } {
  if (typeof message.content === 'string') return { role: message.role, content: message.content }
  return {
    role: message.role,
    content: message.content.map((part) =>
      part.type === 'text'
        ? { type: 'text' as const, text: part.text }
        : { type: 'image_url' as const, image_url: { url: `data:${part.mediaType};base64,${part.data.toString('base64')}` } },
    ),
  }
}

/** Estimated input size of a request, to refuse an oversized one before paying for it. */
export function estimateInputTokens(request: Pick<LlmRequest<unknown>, 'system' | 'messages'>): number {
  let chars = request.system.length
  let images = 0
  for (const message of request.messages) {
    if (typeof message.content === 'string') chars += message.content.length
    else {
      for (const part of message.content) {
        if (part.type === 'text') chars += part.text.length
        else images += 1
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS
}

export function costOf(price: ModelPrice | undefined, inputTokens: number, outputTokens: number): number | null {
  if (!price) return null
  return Math.round(((inputTokens * price.input + outputTokens * price.output) / 1_000_000) * 1_000_000) / 1_000_000
}

interface ChatCompletion {
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/**
 * Language model adapter for OpenAI and Azure OpenAI. Sends strict structured-output requests at
 * temperature 0, validates every answer against the caller's schema, and maps failures: rate limits,
 * 5xx, timeouts and network errors are retryable upstream errors; bad credentials and rejected
 * requests are final; an answer that is cut off, refused or does not fit the schema is a
 * `LlmSchemaError` so the caller can make its one repair attempt.
 *
 * Nothing sent or received is logged: only the component, model, status, timing and token counts.
 */
export function createOpenAiClient(config: OpenAiClientConfig): LLMClient {
  const fetchImpl: Fetch = config.fetch ?? ((url, init) => fetch(url, init))
  /** Models that rejected a temperature of 0 (some reasoning models only accept their default). */
  const noTemperature = new Set<string>()

  async function send(request: LlmRequest<unknown>, withTemperature: boolean) {
    const target = buildTarget(config, 'chat', request.model)
    const body = {
      ...(target.modelInBody ? { model: request.model } : {}),
      messages: [{ role: 'system', content: request.system }, ...request.messages.map(toChatMessage)],
      response_format: { type: 'json_schema', json_schema: { name: request.schema.name, strict: true, schema: request.schema.jsonSchema } },
      max_completion_tokens: request.maxTokens,
      ...(withTemperature ? { temperature: 0 } : {}),
    }
    return postJson(fetchImpl, target.url, target.headers, body, request.timeoutMs)
  }

  return {
    async complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
      if (config.maxInputTokens && estimateInputTokens(request) > config.maxInputTokens) {
        throw new AppError('INTERNAL', 'The document is too long for the model.', { retryable: false, reason: 'LLM_INPUT_TOO_LARGE' })
      }

      const startedAt = Date.now()
      let response = await send(request, !noTemperature.has(request.model))
      if (response.status === 400) {
        const failure = classifyFailure(response.status, response.body, response.headers)
        if (failure.kind === 'unsupported_parameter' && failure.parameter === 'temperature') {
          noTemperature.add(request.model)
          response = await send(request, false)
        }
      }
      const latencyMs = Date.now() - startedAt

      if (response.status < 200 || response.status >= 300) {
        const failure = classifyFailure(response.status, response.body, response.headers)
        logger.warn({ component: request.component, model: request.model, status: response.status, latency_ms: latencyMs, failure: failure.kind }, 'model call failed')
        throw failureToError(failure, response.status)
      }

      const completion = (response.body ?? {}) as ChatCompletion
      const choice = completion.choices?.[0]
      const inputTokens = completion.usage?.prompt_tokens ?? 0
      const outputTokens = completion.usage?.completion_tokens ?? 0
      logger.info({ component: request.component, model: request.model, status: response.status, latency_ms: latencyMs, input_tokens: inputTokens, output_tokens: outputTokens, finish: choice?.finish_reason }, 'model call')

      if (choice?.message?.refusal) throw new LlmSchemaError('The model refused to answer. Return the structured answer for the text given.')
      if (choice?.finish_reason === 'length') throw new LlmSchemaError('The answer was cut off. Keep it shorter: fewer items and short notes.')
      const content = choice?.message?.content
      if (typeof content !== 'string' || content.trim() === '') throw new LlmSchemaError('The answer was empty.')

      let raw: unknown
      try {
        raw = JSON.parse(content)
      } catch {
        throw new LlmSchemaError('The answer was not valid JSON.')
      }
      let output: T
      try {
        output = request.schema.parse(raw)
      } catch (error) {
        // Which rules the answer broke (paths and rule messages, never the answer itself), to find prompt or schema problems.
        if (error instanceof LlmSchemaError) logger.warn({ component: request.component, model: request.model, schema_problem: error.detail }, 'model answer rejected')
        throw error
      }
      return {
        output,
        usage: { inputTokens, outputTokens },
        costUsd: costOf(config.prices?.[request.model], inputTokens, outputTokens),
        latencyMs,
        model: request.model,
      }
    },
  }
}
