import { ApiError } from '@/lib/api/errors'
import type { ApiErrorBody, ApiSuccess } from '@/types/domain'

export interface ApiResponse<T> {
  data: T
  meta?: ApiSuccess<T>['meta']
}

let unauthenticatedHandler: (() => void) | null = null

/** Registers the callback run on any 401 (the app shell signs the user out and redirects). */
export function onUnauthenticated(handler: (() => void) | null) {
  unauthenticatedHandler = handler
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiErrorBody).error?.code === 'string'
  )
}

/**
 * Typed fetch wrapper for the JSON API. Unwraps the `{ data, meta }` envelope and throws
 * `ApiError` for error envelopes and network failures.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  const headers = new Headers(init.headers)
  if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  let response: Response
  try {
    response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  } catch {
    throw new ApiError('NETWORK', 'Unable to reach the server. Check your connection and retry.', 0, null)
  }

  let payload: unknown = null
  if (response.status !== 204) {
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    if (response.status === 401) unauthenticatedHandler?.()
    if (isErrorBody(payload)) {
      const { code, message, request_id: requestId, details } = payload.error
      throw new ApiError(code, message, response.status, requestId, details)
    }
    throw new ApiError(
      'INTERNAL',
      'The server returned an unexpected response.',
      response.status,
      response.headers.get('x-request-id'),
    )
  }

  if (response.status === 204 || payload === null) return { data: undefined as T }
  const body = payload as ApiSuccess<T>
  return { data: body.data, meta: body.meta }
}
