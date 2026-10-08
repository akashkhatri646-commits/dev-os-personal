import { ERROR_HTTP_STATUS, type ErrorCode } from '@/types/domain'

export interface AppErrorOptions {
  /** Machine-readable detail returned to the caller (never PHI). */
  details?: unknown
  /** Whether a queued job may retry after this error. */
  retryable?: boolean
  retryAfterSeconds?: number
  /** Domain-specific sub-code, e.g. THRESHOLD_TOO_LOW, returned as `details.reason`. */
  reason?: string
  cause?: unknown
}

/** Typed error thrown by server code; mapped to the API error envelope by `route()`. */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly httpStatus: number
  readonly retryable: boolean
  readonly retryAfterSeconds?: number
  readonly details?: unknown
  readonly reason?: string

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'AppError'
    this.code = code
    this.httpStatus = ERROR_HTTP_STATUS[code]
    this.retryable = options.retryable ?? code === 'UPSTREAM_ERROR'
    this.retryAfterSeconds = options.retryAfterSeconds
    this.details = options.details
    this.reason = options.reason
  }
}

/** Error raised on the client when an API call returns the error envelope or cannot be reached. */
export class ApiError extends Error {
  readonly code: ErrorCode | 'NETWORK'
  readonly status: number
  readonly requestId: string | null
  readonly details?: unknown

  constructor(
    code: ErrorCode | 'NETWORK',
    message: string,
    status: number,
    requestId: string | null,
    details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.requestId = requestId
    this.details = details
  }
}
