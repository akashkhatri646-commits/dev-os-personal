import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { buildPage, cursorFilter, decodeCursor } from '@/lib/api/pagination'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import type { InviteUserInput, UpdateUserInput } from '@/lib/validation/auth'
import { appendAudit } from '@/server/services/audit/auditLog'
import { getEnv } from '@/server/config/env'
import { logger } from '@/server/logger'
import { ROLES, type AuthUser, type UserSummary } from '@/types/domain'

const profileRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  full_name: z.string().nullable(),
  role: z.enum(ROLES),
  active: z.boolean(),
  created_at: z.string(),
})

/** Ban duration that effectively disables a Supabase auth user until explicitly unbanned. */
const BAN_DURATION = '876000h'

export async function listUsers(
  actor: AuthUser,
  options: { limit: number; cursor?: string },
): Promise<{ users: UserSummary[]; nextCursor: string | null }> {
  const admin = getSupabaseAdmin()
  let query = admin
    .from('profiles')
    .select('id, email, full_name, role, active, created_at')
    .eq('org_id', actor.orgId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(options.limit + 1)
  if (options.cursor) query = query.or(cursorFilter(decodeCursor(options.cursor)))

  const { data, error } = await query
  if (error) throw new AppError('INTERNAL', 'Failed to load users.', { cause: error })

  const rows = z.array(profileRowSchema).parse(data ?? [])
  const { items, nextCursor } = buildPage(rows, options.limit)

  const users = await Promise.all(
    items.map(async (row): Promise<UserSummary> => {
      const { data: authUser } = await admin.auth.admin.getUserById(row.id)
      return { ...row, last_sign_in_at: authUser?.user?.last_sign_in_at ?? null }
    }),
  )
  return { users, nextCursor }
}

/**
 * Invites a user by email into the actor's organisation. The auth user and profile are created
 * together; if the profile insert fails the auth user is removed so no orphan can sign in.
 */
export async function inviteUser(actor: AuthUser, input: InviteUserInput): Promise<{ id: string }> {
  const admin = getSupabaseAdmin()

  const { data: existing, error: lookupError } = await admin
    .from('profiles')
    .select('id')
    .eq('email', input.email)
    .maybeSingle()
  if (lookupError) throw new AppError('INTERNAL', 'Failed to check for an existing user.', { cause: lookupError })
  if (existing) {
    throw new AppError('CONFLICT', 'A user with this email already exists.', { reason: 'EMAIL_EXISTS' })
  }

  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(input.email, {
    redirectTo: `${getEnv().APP_BASE_URL}/auth/callback`,
  })
  if (inviteError || !invited.user) {
    if (inviteError && /already.*registered|already.*exists/i.test(inviteError.message)) {
      throw new AppError('CONFLICT', 'A user with this email already exists.', { reason: 'EMAIL_EXISTS' })
    }
    throw new AppError('UPSTREAM_ERROR', 'Could not send the invitation email.', { cause: inviteError })
  }

  const userId = invited.user.id
  const { error: profileError } = await admin.from('profiles').insert({
    id: userId,
    org_id: actor.orgId,
    email: input.email,
    full_name: input.full_name,
    role: input.role,
  })
  if (profileError) {
    const { error: cleanupError } = await admin.auth.admin.deleteUser(userId)
    if (cleanupError) logger.error({ user_id: userId, err: cleanupError }, 'failed to remove orphan auth user')
    throw new AppError('INTERNAL', 'Failed to create the user profile.', { cause: profileError })
  }

  await appendAudit({
    orgId: actor.orgId,
    actor: { type: 'user', id: actor.userId },
    event: 'user.created',
    payload: { user_id: userId, role: input.role },
  })
  return { id: userId }
}

/**
 * Updates role / active flag / name. Self-service changes to role or active state are rejected, and
 * the database function guarantees the organisation keeps at least one active admin.
 */
export async function updateUser(
  actor: AuthUser,
  targetId: string,
  input: UpdateUserInput,
): Promise<UserSummary> {
  if (targetId === actor.userId && (input.role !== undefined || input.active !== undefined)) {
    throw new AppError('CONFLICT', 'You cannot change your own role or active status.', {
      reason: 'SELF_MODIFICATION',
    })
  }

  const admin = getSupabaseAdmin()
  const { data: before, error: beforeError } = await admin
    .from('profiles')
    .select('role, active')
    .eq('id', targetId)
    .eq('org_id', actor.orgId)
    .maybeSingle()
  if (beforeError) throw new AppError('INTERNAL', 'Failed to load the user.', { cause: beforeError })
  if (!before) throw new AppError('NOT_FOUND', 'User not found.')

  const { data, error } = await admin.rpc('admin_update_profile', {
    p_org: actor.orgId,
    p_target: targetId,
    p_changes: input,
  })
  if (error) {
    if (error.message.includes('last_admin')) {
      throw new AppError('CONFLICT', 'The organisation must keep at least one active admin.', {
        reason: 'LAST_ADMIN',
      })
    }
    if (error.message.includes('not_found')) throw new AppError('NOT_FOUND', 'User not found.')
    throw new AppError('INTERNAL', 'Failed to update the user.', { cause: error })
  }

  const updated = profileRowSchema.parse(data)

  if (input.active !== undefined && input.active !== before.active) {
    // Defence in depth: also block sign-in at the identity provider. getAuthUser() already rejects inactive profiles.
    const { error: banError } = await admin.auth.admin.updateUserById(targetId, {
      ban_duration: input.active ? 'none' : BAN_DURATION,
    })
    if (banError) logger.warn({ user_id: targetId, err: banError }, 'failed to sync auth ban state')
  }

  if (input.role !== undefined && input.role !== before.role) {
    await appendAudit({
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId },
      event: 'user.role_changed',
      payload: { user_id: targetId, from: before.role, to: input.role },
    })
  }

  const { data: authUser } = await admin.auth.admin.getUserById(targetId)
  return { ...updated, last_sign_in_at: authUser?.user?.last_sign_in_at ?? null }
}
