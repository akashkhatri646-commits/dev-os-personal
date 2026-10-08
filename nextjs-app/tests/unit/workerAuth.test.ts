import { describe, expect, it, vi } from 'vitest'

vi.mock('@/server/config/env', () => ({ getEnv: () => ({ WORKER_SECRET: undefined }) }))

import { AppError } from '@/lib/api/errors'
import { verifyWorkerSecret } from '@/server/worker/auth'

const SECRET = 'a'.repeat(40)

function request(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/worker/tick', { method: 'POST', headers })
}

describe('verifyWorkerSecret', () => {
  it('accepts the exact secret', () => {
    expect(() => verifyWorkerSecret(request({ 'x-worker-secret': SECRET }), SECRET)).not.toThrow()
  })

  it.each([
    ['missing header', {}],
    ['wrong value', { 'x-worker-secret': 'b'.repeat(40) }],
    ['shorter value', { 'x-worker-secret': 'a'.repeat(10) }],
    ['longer value', { 'x-worker-secret': `${SECRET}x` }],
  ])('rejects a %s with 401', (_label, headers) => {
    let thrown: unknown
    try {
      verifyWorkerSecret(request(headers), SECRET)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).httpStatus).toBe(401)
  })

  it('fails closed when no secret is configured, even if the header is empty or present', () => {
    expect(() => verifyWorkerSecret(request({ 'x-worker-secret': '' }), undefined)).toThrow(AppError)
    expect(() => verifyWorkerSecret(request({ 'x-worker-secret': SECRET }), undefined)).toThrow(AppError)
  })
})
