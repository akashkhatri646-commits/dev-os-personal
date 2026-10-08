import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import { ZodError, type z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { allowedHosts, assertSameOrigin, clientIp } from '@/lib/api/requestOrigin'
import { getAuthUser, requireRole } from '@/lib/auth/withAuth'
import { getEnv } from '@/server/config/env'
import { logger } from '@/server/logger'
import { checkRateLimit } from '@/server/rateLimit'
import { checkDurableRateLimit } from '@/server/rateLimitDurable'
import type { ApiErrorBody, ApiSuccess, AuthUser, Role } from '@/types/domain'

/** Result returned by handlers; serialised into the `{ data, meta }` envelope. */
export interface ApiResult<T> {
  data: T
  meta?: ApiSuccess<T>['meta']
  status?: number
  headers?: Record<string, string>
}

export const ok = <T>(data: T, meta?: ApiSuccess<T>['meta']): ApiResult<T> => ({ data, meta })
export const created = <T>(data: T): ApiResult<T> => ({ data, status: 201 })
export const accepted = <T>(data: T): ApiResult<T> => ({ data, status: 202 })

export interface HandlerContext<TBody, TQuery, TParams> {
  req: NextRequest
  requestId: string
  /** Null only on routes declared `public: true`. */
  user: AuthUser | null
  body: TBody
  query: TQuery
  params: TParams
}

export interface RouteOptions<TBody, TQuery, TParams, TResult> {
  /** Roles allowed to call the route. Omit for "any authenticated user". Ignored when `public`. */
  roles?: readonly Role[]
  /** Skips authentication (health check, secret-protected internals that authenticate themselves). */
  public?: boolean
  /** Validates a JSON request body. Omit for routes that read the body themselves (e.g. multipart). */
  body?: z.ZodType<TBody>
  query?: z.ZodType<TQuery>
  /** Overrides the default per-user limit (RATE_LIMIT_USER_PER_MIN). */
  rateLimitPerMinute?: number
  /** Returns the JSON envelope payload, or a raw `Response` for file downloads. */
  handler: (ctx: HandlerContext<TBody, TQuery, TParams>) => Promise<ApiResult<TResult> | Response>
}

type NextRouteContext<TParams> = { params: TParams }

function errorBody(
  code: ApiErrorBody['error']['code'],
  message: string,
  requestId: string,
  details?: unknown,
): ApiErrorBody {
  return { error: { code, message, request_id: requestId, ...(details !== undefined ? { details } : {}) } }
}

function toErrorResponse(error: unknown, requestId: string): NextResponse<ApiErrorBody> {
  const headers: Record<string, string> = { 'x-request-id': requestId, 'cache-control': 'no-store' }

  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => {
      const reason =
        issue.code === 'custom' && typeof issue.params?.reason === 'string' ? issue.params.reason : undefined
      return { path: issue.path, message: issue.message, ...(reason ? { reason } : {}) }
    })
    return NextResponse.json(
      errorBody('VALIDATION_FAILED', 'Request validation failed.', requestId, details),
      { status: 422, headers },
    )
  }

  if (error instanceof AppError) {
    if (error.retryAfterSeconds) headers['retry-after'] = String(error.retryAfterSeconds)
    const details =
      error.reason !== undefined
        ? { reason: error.reason, ...(typeof error.details === 'object' && error.details !== null ? error.details : {}) }
        : error.details
    return NextResponse.json(errorBody(error.code, error.message, requestId, details), {
      status: error.httpStatus,
      headers,
    })
  }

  logger.error({ request_id: requestId, err: error }, 'unhandled route error')
  return NextResponse.json(errorBody('INTERNAL', 'An unexpected error occurred.', requestId), {
    status: 500,
    headers,
  })
}

async function parseJsonBody<TBody>(req: NextRequest, schema: z.ZodType<TBody>): Promise<TBody> {
  const contentType = req.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.')
  }
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Request body is not valid JSON.')
  }
  return schema.parse(raw)
}

/**
 * Wraps a Next.js route handler with the standard pipeline (spec 00 §6):
 * request id → authn → role check → rate limit → Zod parse → handler → envelope/error mapping.
 * Logs only `{request_id, route, user_id, status, ms}`; request bodies are never logged.
 */
export function route<
  TResult,
  TBody = undefined,
  TQuery = undefined,
  TParams extends Record<string, string> = Record<string, string>,
>(options: RouteOptions<TBody, TQuery, TParams, TResult>) {
  return async (req: NextRequest, context?: NextRouteContext<TParams>): Promise<NextResponse> => {
    const startedAt = Date.now()
    const requestId = req.headers.get('x-request-id') || crypto.randomUUID()
    let user: AuthUser | null = null
    let response: NextResponse

    try {
      assertSameOrigin(req, allowedHosts(req, getEnv().APP_BASE_URL))
      if (!options.public) {
        user = await getAuthUser(req)
        if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
        if (options.roles) requireRole(user, options.roles)
        checkRateLimit(
          `user:${user.userId}`,
          options.rateLimitPerMinute ?? getEnv().RATE_LIMIT_USER_PER_MIN,
        )
        // A route that sets its own limit is a sensitive one: count it across all server instances too.
        if (options.rateLimitPerMinute) await checkDurableRateLimit(`user:${user.userId}:${req.nextUrl.pathname}`, options.rateLimitPerMinute)
      } else if (options.rateLimitPerMinute) {
        const key = `ip:${clientIp(req)}:${req.nextUrl.pathname}`
        checkRateLimit(key, options.rateLimitPerMinute)
        await checkDurableRateLimit(key, options.rateLimitPerMinute)
      }

      const query = options.query
        ? options.query.parse(Object.fromEntries(req.nextUrl.searchParams))
        : (undefined as TQuery)
      const body = options.body ? await parseJsonBody(req, options.body) : (undefined as TBody)

      const result = await options.handler({
        req,
        requestId,
        user,
        body,
        query,
        params: (context?.params ?? {}) as TParams,
      })

      if (result instanceof Response) {
        // Raw responses (file downloads) bypass the JSON envelope but still carry the request id.
        result.headers.set('x-request-id', requestId)
        result.headers.set('cache-control', 'no-store')
        response = result as NextResponse
      } else {
        const envelope: ApiSuccess<TResult> = {
          data: result.data,
          ...(result.meta ? { meta: result.meta } : {}),
        }
        response = NextResponse.json(envelope, {
          status: result.status ?? 200,
          headers: { 'x-request-id': requestId, 'cache-control': 'no-store', ...result.headers },
        })
      }
    } catch (error) {
      response = toErrorResponse(error, requestId)
    }

    logger.info({
      request_id: requestId,
      route: req.nextUrl.pathname,
      method: req.method,
      user_id: user?.userId ?? null,
      status: response.status,
      ms: Date.now() - startedAt,
    })
    return response
  }
}
