export type LlmComponent = 'extraction' | 'mapping' | 'scoring' | 'routing_explain'

export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: Buffer }

export interface LlmMessage {
  role: 'user' | 'assistant'
  content: string | LlmContentPart[]
}

/**
 * The structured output a call must return. `jsonSchema` is sent to the provider (OpenAI strict
 * structured outputs: every property required, nullable instead of optional, no extra keys) and
 * `parse` validates what comes back, throwing when it does not conform.
 */
export interface LlmSchema<T> {
  name: string
  jsonSchema: Record<string, unknown>
  parse: (raw: unknown) => T
}

export interface LlmRequest<T> {
  component: LlmComponent
  /** Model id (for Azure OpenAI: the deployment name). */
  model: string
  system: string
  messages: LlmMessage[]
  schema: LlmSchema<T>
  maxTokens: number
  timeoutMs: number
  /** Record being processed; used for cost attribution and logs, never sent to the provider. */
  recordId: string
}

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
}

export interface LlmResponse<T> {
  output: T
  usage: LlmUsage
  /** Null when the model has no configured price. */
  costUsd: number | null
  latencyMs: number
  model: string
}

/**
 * A language-model provider. Adapters call temperature 0, return validated output, map rate limits,
 * 5xx and timeouts to a retryable `UPSTREAM_ERROR`, and throw `LlmSchemaError` when the answer does
 * not match the schema so the caller can make one repair attempt.
 */
export interface LLMClient {
  complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>>
}

/** The model answered, but not in the required structure. `detail` is safe to show to the model. */
export class LlmSchemaError extends Error {
  readonly detail: string

  constructor(detail: string) {
    super('The model output did not match the required schema.')
    this.name = 'LlmSchemaError'
    this.detail = detail
  }
}
