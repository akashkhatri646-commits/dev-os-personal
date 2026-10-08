import { createHash } from 'node:crypto'
import { AppError } from '@/lib/api/errors'
import type { LLMClient, LlmMessage, LlmRequest, LlmResponse } from '@/types/llm'

export interface ReplayEntry {
  output: unknown
  usage: { inputTokens: number; outputTokens: number }
  costUsd: number | null
  latencyMs: number
  model: string
}

type KeyedRequest = Pick<LlmRequest<unknown>, 'component' | 'model' | 'system' | 'messages'> & {
  schema: { name: string }
}

function messageFingerprint(message: LlmMessage) {
  if (typeof message.content === 'string') return { role: message.role, content: message.content }
  return {
    role: message.role,
    content: message.content.map((part) =>
      part.type === 'text'
        ? { type: 'text', text: part.text }
        : { type: 'image', mediaType: part.mediaType, sha256: createHash('sha256').update(part.data).digest('hex') },
    ),
  }
}

/**
 * Stable key for a request: a hash of everything that determines the model's answer. The same
 * prompt, document and schema always map to the same recorded response.
 */
export function requestKey(request: KeyedRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        component: request.component,
        model: request.model,
        system: request.system,
        schema: request.schema.name,
        messages: request.messages.map(messageFingerprint),
      }),
    )
    .digest('hex')
}

/**
 * Answers from recorded responses only and never contacts a provider, so evaluations and tests run
 * offline, free and deterministically. An unrecorded request is an error, never a guess.
 */
export class ReplayLLMClient implements LLMClient {
  constructor(private readonly entries: Readonly<Record<string, ReplayEntry>>) {}

  async complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    const entry = this.entries[requestKey(request)]
    if (!entry) {
      throw new AppError('INTERNAL', 'No recorded model response exists for this request.', {
        reason: 'REPLAY_MISS',
        retryable: false,
      })
    }
    return {
      // Re-validate so a stale fixture that no longer fits the schema fails loudly.
      output: request.schema.parse(entry.output),
      usage: entry.usage,
      costUsd: entry.costUsd,
      latencyMs: entry.latencyMs,
      model: entry.model,
    }
  }
}

/** Wraps a real client and stores every response, producing the fixtures `ReplayLLMClient` reads. */
export class RecordingLLMClient implements LLMClient {
  readonly recorded: Record<string, ReplayEntry> = {}

  constructor(private readonly inner: LLMClient) {}

  async complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    const response = await this.inner.complete(request)
    this.recorded[requestKey(request)] = {
      output: response.output,
      usage: response.usage,
      costUsd: response.costUsd,
      latencyMs: response.latencyMs,
      model: response.model,
    }
    return response
  }
}
