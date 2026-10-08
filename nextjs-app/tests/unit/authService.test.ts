import { beforeEach, describe, expect, it, vi } from 'vitest'

const profileRow = vi.fn()
const rpc = vi.fn()
const signInWithPassword = vi.fn()
const signOut = vi.fn()
const appendAuditBestEffort = vi.fn()

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => profileRow() }) }) }),
    rpc: (...args: unknown[]) => rpc(...args),
  }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({ auth: { signInWithPassword, signOut } }),
}))
vi.mock('@/server/config/env', () => ({ getEnv: () => ({ APP_BASE_URL: 'http://localhost:3000' }) }))
vi.mock('@/server/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/server/services/audit/auditLog', () => ({
  appendAuditBestEffort: (...args: unknown[]) => appendAuditBestEffort(...args),
}))

import { AppError } from '@/lib/api/errors'
import { signInWithPassword as login } from '@/server/services/auth/authService'

const baseProfile = {
  id: 'user-1',
  org_id: 'org-1',
  role: 'reviewer',
  active: true,
  locked_until: null,
}

async function catchError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    return error as AppError
  }
  throw new Error('expected rejection')
}

describe('signInWithPassword (lockout and account state)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rpc.mockResolvedValue({ error: null })
  })

  it('rejects a locked account WITHOUT checking the password', async () => {
    profileRow.mockResolvedValue({
      data: { ...baseProfile, locked_until: new Date(Date.now() + 60_000).toISOString() },
      error: null,
    })
    const error = await catchError(login('a@b.co', 'correct-password'))
    expect(error.code).toBe('UNAUTHENTICATED')
    expect(signInWithPassword).not.toHaveBeenCalled()
  })

  it('records a failure for a known account with a wrong password', async () => {
    profileRow.mockResolvedValue({ data: baseProfile, error: null })
    signInWithPassword.mockResolvedValue({ data: { user: null }, error: { message: 'bad' } })
    const error = await catchError(login('a@b.co', 'wrong'))
    expect(error.reason).toBe('INVALID_CREDENTIALS')
    expect(rpc).toHaveBeenCalledWith('record_login_failure', { p_email: 'a@b.co' })
  })

  it('returns the same error for an unknown email and does not record a failure', async () => {
    profileRow.mockResolvedValue({ data: null, error: null })
    signInWithPassword.mockResolvedValue({ data: { user: null }, error: { message: 'bad' } })
    const error = await catchError(login('nobody@b.co', 'x'))
    expect(error.reason).toBe('INVALID_CREDENTIALS')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('discards the session of a deactivated user', async () => {
    profileRow.mockResolvedValue({ data: { ...baseProfile, active: false }, error: null })
    signInWithPassword.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    const error = await catchError(login('a@b.co', 'right'))
    expect(error.code).toBe('UNAUTHENTICATED')
    expect(signOut).toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalledWith('reset_login_failures', expect.anything())
  })

  it('resets counters and returns the role on success', async () => {
    profileRow.mockResolvedValue({ data: baseProfile, error: null })
    signInWithPassword.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    await expect(login('a@b.co', 'right')).resolves.toEqual({ role: 'reviewer' })
    expect(rpc).toHaveBeenCalledWith('reset_login_failures', { p_user: 'user-1' })
    expect(appendAuditBestEffort).toHaveBeenCalledWith(expect.objectContaining({ event: 'auth.login' }))
  })

  it('never writes the email into audit payloads', async () => {
    profileRow.mockResolvedValue({ data: baseProfile, error: null })
    signInWithPassword.mockResolvedValue({ data: { user: null }, error: { message: 'bad' } })
    await catchError(login('a@b.co', 'wrong'))
    expect(JSON.stringify(appendAuditBestEffort.mock.calls)).not.toContain('a@b.co')
  })
})
