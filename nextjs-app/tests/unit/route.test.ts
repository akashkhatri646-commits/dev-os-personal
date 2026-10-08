import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AuthUser } from '@/types/domain'

const getAuthUser = vi.fn<() => Promise<AuthUser | null>>()

vi.mock('@/lib/auth/withAuth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/withAuth')>('@/lib/auth/withAuth')
  return { ...actual, getAuthUser: () => getAuthUser() }
})
vi.mock('@/server/config/env', () => ({ getEnv: () => ({ RATE_LIMIT_USER_PER_MIN: 1000 }) }))
vi.mock('@/server/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'

const admin: AuthUser = {
  userId: 'u1',
  email: 'a@b.co',
  orgId: 'o1',
  orgName: 'Org',
  fullName: 'Ada',
  role: 'admin',
}

function request(url = 'http://localhost/api/test', init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(url, init)
}

describe('route()', () => {
  beforeEach(() => {
    getAuthUser.mockReset()
  })

  it('returns 401 UNAUTHENTICATED without a user', async () => {
    getAuthUser.mockResolvedValue(null)
    const response = await route({ handler: async () => ok({}) })(request())
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('UNAUTHENTICATED')
  })

  it('returns 403 FORBIDDEN when the role is not allowed', async () => {
    getAuthUser.mockResolvedValue({ ...admin, role: 'reviewer' })
    const response = await route({ roles: ['admin'], handler: async () => ok({}) })(request())
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('FORBIDDEN')
  })

  it('wraps successful results in the data/meta envelope with a request id', async () => {
    getAuthUser.mockResolvedValue(admin)
    const response = await route({
      roles: ['admin'],
      handler: async () => ok({ hello: 'world' }, { next_cursor: null }),
    })(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(await response.json()).toEqual({ data: { hello: 'world' }, meta: { next_cursor: null } })
  })

  it('returns 422 with field details for invalid input', async () => {
    getAuthUser.mockResolvedValue(admin)
    const response = await route({
      body: z.object({ name: z.string().min(2) }),
      handler: async ({ body }) => ok(body),
    })(
      request('http://localhost/api/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x' }),
      }),
    )
    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details[0].path).toEqual(['name'])
  })

  it('returns 415 when a JSON body is required but the content type differs', async () => {
    getAuthUser.mockResolvedValue(admin)
    const response = await route({
      body: z.object({}),
      handler: async () => ok({}),
    })(request('http://localhost/api/test', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } }))
    expect(response.status).toBe(415)
  })

  it('maps AppError reason into details and statuses', async () => {
    getAuthUser.mockResolvedValue(admin)
    const response = await route({
      handler: async () => {
        throw new AppError('CONFLICT', 'Taken', { reason: 'EMAIL_EXISTS' })
      },
    })(request())
    expect(response.status).toBe(409)
    expect((await response.json()).error.details).toEqual({ reason: 'EMAIL_EXISTS' })
  })

  it('hides internals of unexpected errors', async () => {
    getAuthUser.mockResolvedValue(admin)
    const response = await route({
      handler: async () => {
        throw new Error('secret connection string')
      },
    })(request())
    expect(response.status).toBe(500)
    const text = JSON.stringify(await response.json())
    expect(text).toContain('INTERNAL')
    expect(text).not.toContain('secret connection string')
  })

  it('serves public routes without authentication and rate limits them', async () => {
    const limited = route({ public: true, rateLimitPerMinute: 2, handler: async () => ok({ ok: true }) })
    const makeRequest = () =>
      request('http://localhost/api/limited', { headers: { 'x-forwarded-for': '203.0.113.9' } })
    expect((await limited(makeRequest())).status).toBe(200)
    expect((await limited(makeRequest())).status).toBe(200)
    const blocked = await limited(makeRequest())
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBeTruthy()
    expect(getAuthUser).not.toHaveBeenCalled()
  })
})
