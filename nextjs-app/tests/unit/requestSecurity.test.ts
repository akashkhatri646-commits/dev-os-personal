import { beforeEach, describe, expect, it, vi } from 'vitest'

const holder = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => ({ rpc: holder.rpc }) }))
vi.mock('@/server/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { assertSameOrigin, clientIp } from '@/lib/api/requestOrigin'
import { sessionCookieOptions } from '@/lib/supabase/sessionCookies'
import { checkDurableRateLimit } from '@/server/rateLimitDurable'

const request = (method: string, headers: Record<string, string> = {}) => new Request('https://app.example.com/api/x', { method, headers })
const HOSTS = ['app.example.com']

describe('same-origin check', () => {
  it('lets reads, same-site posts, posts without an origin, and header-authenticated callers through', () => {
    expect(() => assertSameOrigin(request('GET', { origin: 'https://evil.test' }), HOSTS)).not.toThrow()
    expect(() => assertSameOrigin(request('POST', { origin: 'https://app.example.com' }), HOSTS)).not.toThrow()
    expect(() => assertSameOrigin(request('POST'), HOSTS)).not.toThrow()
    expect(() => assertSameOrigin(request('POST', { origin: 'https://evil.test', 'x-source-key': 'k' }), HOSTS)).not.toThrow()
    expect(() => assertSameOrigin(request('POST', { origin: 'https://evil.test', authorization: 'Bearer t' }), HOSTS)).not.toThrow()
  })

  it('refuses a state-changing request from another website, or with a malformed origin', () => {
    expect(() => assertSameOrigin(request('POST', { origin: 'https://evil.test' }), HOSTS)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => assertSameOrigin(request('DELETE', { origin: 'null' }), HOSTS)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
  })
})

describe('client address', () => {
  it('prefers the hosting provider header over one the client can write', () => {
    expect(clientIp(request('GET', { 'x-nf-client-connection-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('203.0.113.9')
    expect(clientIp(request('GET', { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('1.2.3.4')
    expect(clientIp(request('GET'))).toBe('unknown')
  })
})

describe('durable rate limit', () => {
  beforeEach(() => holder.rpc.mockReset())

  it('allows a hit the database accepts and refuses one it rejects, with the retry time', async () => {
    holder.rpc.mockResolvedValueOnce({ data: 0, error: null })
    await expect(checkDurableRateLimit('ip:1', 5)).resolves.toBeUndefined()
    holder.rpc.mockResolvedValueOnce({ data: 42, error: null })
    await expect(checkDurableRateLimit('ip:1', 5)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 42 })
    expect(holder.rpc).toHaveBeenCalledWith('rate_limit_hit', { p_key: 'ip:1', p_limit: 5, p_window_seconds: 60 })
  })

  it('does not lock everyone out when the database cannot be reached', async () => {
    holder.rpc.mockRejectedValueOnce(new Error('down'))
    await expect(checkDurableRateLimit('ip:1', 5)).resolves.toBeUndefined()
    holder.rpc.mockResolvedValueOnce({ data: null, error: { message: 'function missing' } })
    await expect(checkDurableRateLimit('ip:1', 5)).resolves.toBeUndefined()
  })
})

describe('session cookies', () => {
  it('drops any lifetime so the cookie ends with the browser, and keeps removal working', () => {
    expect(sessionCookieOptions({ path: '/', maxAge: 400 * 86400, expires: new Date() })).not.toHaveProperty('maxAge')
    expect(sessionCookieOptions({ path: '/', maxAge: 400 * 86400, expires: new Date() })).not.toHaveProperty('expires')
    expect(sessionCookieOptions({ path: '/', maxAge: 0 })).toMatchObject({ maxAge: 0 })
  })
})
