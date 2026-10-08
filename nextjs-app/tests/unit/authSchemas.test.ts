import { describe, expect, it } from 'vitest'
import {
  inviteUserSchema,
  loginSchema,
  updateUserSchema,
  userIdParamsSchema,
} from '@/lib/validation/auth'

describe('auth schemas', () => {
  it('normalises email to lower case and trims it', () => {
    const parsed = loginSchema.parse({ email: '  Ada@Example.COM ', password: 'x' })
    expect(parsed.email).toBe('ada@example.com')
  })

  it('rejects malformed emails and empty passwords', () => {
    expect(loginSchema.safeParse({ email: 'nope', password: 'x' }).success).toBe(false)
    expect(loginSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false)
  })

  it('validates invitations', () => {
    expect(inviteUserSchema.safeParse({ email: 'a@b.co', full_name: 'Ada', role: 'reviewer' }).success).toBe(true)
    expect(inviteUserSchema.safeParse({ email: 'a@b.co', full_name: '', role: 'reviewer' }).success).toBe(false)
    expect(inviteUserSchema.safeParse({ email: 'a@b.co', full_name: 'Ada', role: 'root' }).success).toBe(false)
  })

  it('requires at least one field when updating a user', () => {
    expect(updateUserSchema.safeParse({}).success).toBe(false)
    expect(updateUserSchema.safeParse({ active: false }).success).toBe(true)
    expect(updateUserSchema.safeParse({ role: 'admin' }).success).toBe(true)
  })

  it('requires a UUID user id', () => {
    expect(userIdParamsSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false)
    expect(userIdParamsSchema.safeParse({ id: '3f2b8c1e-5c1a-4d6e-9c5e-2f7a1b0d9e11' }).success).toBe(true)
  })
})
