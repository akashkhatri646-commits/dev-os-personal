import { describe, expect, it } from 'vitest'
import { AppError } from '@/lib/api/errors'
import { checkRateLimit } from '@/server/rateLimit'

describe('checkRateLimit', () => {
  it('allows up to the limit then throws RATE_LIMITED with a retry hint', () => {
    const key = `test-${Math.random()}`
    const now = 1_000_000
    for (let i = 0; i < 3; i += 1) expect(() => checkRateLimit(key, 3, now)).not.toThrow()

    let thrown: unknown
    try {
      checkRateLimit(key, 3, now + 10_000)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).code).toBe('RATE_LIMITED')
    expect((thrown as AppError).retryAfterSeconds).toBe(50)
  })

  it('starts a fresh window after 60 seconds', () => {
    const key = `test-${Math.random()}`
    checkRateLimit(key, 1, 0)
    expect(() => checkRateLimit(key, 1, 61_000)).not.toThrow()
  })

  it('tracks keys independently', () => {
    const now = 5_000_000
    checkRateLimit(`a-${now}`, 1, now)
    expect(() => checkRateLimit(`b-${now}`, 1, now)).not.toThrow()
  })
})
