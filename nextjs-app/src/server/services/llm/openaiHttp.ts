import { AppError } from '@/lib/api/errors'

/** Where and how to reach the provider: OpenAI directly, or an Azure OpenAI resource (for in-region data). */
export interface ProviderConfig {
  provider: 'openai' | 'azure_openai'
  apiKey: string
  /** Azure resource endpoint, e.g. https://name.openai.azure.com */
  endpoint?: string
  /** Azure API version string. */
  apiVersion?: string
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

const OPENAI_BASE = 'https://api.openai.com/v1'

export interface Target {
  url: string
  headers: Record<string, string>
  /** OpenAI takes the model in the body; Azure takes it (the deployment name) in the URL. */
  modelInBody: boolean
}

/** The URL and headers for a chat or embeddings call. For Azure, `model` is the deployment name. */
export function buildTarget(config: ProviderConfig, kind: 'chat' | 'embeddings', model: string): Target {
  const path = kind === 'chat' ? 'chat/completions' : 'embeddings'
  if (config.provider === 'openai') {
    return { url: `${OPENAI_BASE}/${path}`, headers: { authorization: `Bearer ${config.apiKey}` }, modelInBody: true }
  }
  const endpoint = (config.endpoint ?? '').replace(/\/+$/, '')
  return {
    url: `${endpoint}/openai/deployments/${encodeURIComponent(model)}/${path}?api-version=${encodeURIComponent(config.apiVersion ?? '')}`,
    headers: { 'api-key': config.apiKey },
    modelInBody: false,
  }
}

/** A provider message that is safe to keep: the error `message` the API returned, never anything we sent. */
function providerMessage(body: unknown): string {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message
  return typeof message === 'string' ? message.slice(0, 300) : ''
}

export type FailureKind = 'retryable' | 'credentials' | 'limit' | 'bad_request' | 'unsupported_parameter'

export interface ClassifiedFailure {
  kind: FailureKind
  message: string
  retryAfterSeconds?: number
  /** The parameter the provider says it does not accept, when it names one. */
  parameter?: string
}

/** Sorts an error response into what the caller should do about it. */
export function classifyFailure(status: number, body: unknown, headers: Headers): ClassifiedFailure {
  const message = providerMessage(body)
  const retryAfter = Number(headers.get('retry-after'))
  const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(Math.ceil(retryAfter), 120) : undefined
  if (status === 429 || status >= 500 || status === 408 || status === 409) {
    return { kind: 'retryable', message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) }
  }
  if (status === 401 || status === 403) return { kind: 'credentials', message }
  if (status === 400) {
    const param = (body as { error?: { param?: unknown; code?: unknown } } | null)?.error
    if (/unsupported (parameter|value)|does not support/i.test(message) && typeof param?.param === 'string') {
      return { kind: 'unsupported_parameter', message, parameter: param.param }
    }
    if (/context length|maximum context|too many tokens|reduce the length/i.test(message) || param?.code === 'context_length_exceeded') {
      return { kind: 'limit', message }
    }
  }
  return { kind: 'bad_request', message }
}

/** The AppError a failure becomes. Only transient failures are retryable; the rest need a person. */
export function failureToError(failure: ClassifiedFailure, status: number): AppError {
  if (failure.kind === 'retryable') {
    return new AppError('UPSTREAM_ERROR', `The model provider is unavailable (status ${status}).`, {
      retryable: true,
      ...(failure.retryAfterSeconds ? { retryAfterSeconds: failure.retryAfterSeconds } : {}),
    })
  }
  if (failure.kind === 'credentials') {
    return new AppError('INTERNAL', 'The model provider rejected the credentials. Check the API key and endpoint.', { retryable: false, reason: 'LLM_CREDENTIALS' })
  }
  if (failure.kind === 'limit') {
    return new AppError('INTERNAL', 'The document is too long for the model.', { retryable: false, reason: 'LLM_INPUT_TOO_LARGE' })
  }
  return new AppError('INTERNAL', `The model provider rejected the request (status ${status}). ${failure.message}`.trim(), { retryable: false, reason: 'LLM_BAD_REQUEST' })
}

export interface JsonResponse {
  status: number
  body: unknown
  headers: Headers
}

/** POSTs JSON with a hard timeout. Network errors and timeouts are transient (retryable). */
export async function postJson(fetchImpl: Fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<JsonResponse> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    throw new AppError('UPSTREAM_ERROR', timedOut ? 'The model provider did not answer in time.' : 'The model provider could not be reached.', { retryable: true })
  }
  let parsed: unknown = null
  try {
    parsed = await response.json()
  } catch {
    parsed = null
  }
  return { status: response.status, body: parsed, headers: response.headers }
}
