import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthUser } from '@/types/domain'

const beforeRow = vi.fn()
const rpc = vi.fn()
const updateUserById = vi.fn()
const getUserById = vi.fn()
const appendAudit = vi.fn()

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => beforeRow() }) }) }) }),
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { admin: { updateUserById, getUserById } },
  }),
}))
vi.mock('@/server/config/env', () => ({ getEnv: () => ({ APP_BASE_URL: 'http://localhost:3000' }) }))
vi.mock('@/server/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/server/services/audit/auditLog', () => ({
  appendAudit: (...args: unknown[]) => appendAudit(...args),
}))

import { AppError } from '@/lib/api/errors'
import { updateUser } from '@/server/services/users/userService'

const actor: AuthUser = {
  userId: 'admin-1',
  email: 'admin@b.co',
  orgId: 'org-1',
  orgName: 'Org',
  fullName: 'Admin',
  role: 'admin',
}

const updatedRow = {
  id: 'user-2',
  email: 'u@b.co',
  full_name: 'U',
  role: 'viewer',
  active: true,
  created_at: '2026-10-01T00:00:00+00:00',
}

async function catchError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    return error as AppError
  }
  throw new Error('expected rejection')
}

describe('updateUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getUserById.mockResolvedValue({ data: { user: { last_sign_in_at: null } } })
    updateUserById.mockResolvedValue({ error: null })
  })

  it('refuses to change your own role or active state without touching the database', async () => {
    const error = await catchError(updateUser(actor, 'admin-1', { role: 'viewer' }))
    expect(error.code).toBe('CONFLICT')
    expect(error.reason).toBe('SELF_MODIFICATION')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns NOT_FOUND for a user outside the organisation', async () => {
    beforeRow.mockResolvedValue({ data: null, error: null })
    const error = await catchError(updateUser(actor, 'user-9', { role: 'viewer' }))
    expect(error.code).toBe('NOT_FOUND')
  })

  it('maps the database last_admin guard to a 409 LAST_ADMIN', async () => {
    beforeRow.mockResolvedValue({ data: { role: 'admin', active: true }, error: null })
    rpc.mockResolvedValue({ data: null, error: { message: 'last_admin' } })
    const error = await catchError(updateUser(actor, 'user-2', { role: 'viewer' }))
    expect(error.code).toBe('CONFLICT')
    expect(error.reason).toBe('LAST_ADMIN')
  })

  it('audits role changes and syncs the ban state when deactivating', async () => {
    beforeRow.mockResolvedValue({ data: { role: 'reviewer', active: true }, error: null })
    rpc.mockResolvedValue({ data: { ...updatedRow, role: 'viewer', active: false }, error: null })
    await updateUser(actor, 'user-2', { role: 'viewer', active: false })

    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user.role_changed',
        payload: { user_id: 'user-2', from: 'reviewer', to: 'viewer' },
      }),
    )
    expect(updateUserById).toHaveBeenCalledWith('user-2', { ban_duration: '876000h' })
  })

  it('does not audit or ban when nothing relevant changed', async () => {
    beforeRow.mockResolvedValue({ data: { role: 'viewer', active: true }, error: null })
    rpc.mockResolvedValue({ data: updatedRow, error: null })
    await updateUser(actor, 'user-2', { full_name: 'New Name' })
    expect(appendAudit).not.toHaveBeenCalled()
    expect(updateUserById).not.toHaveBeenCalled()
  })
})
