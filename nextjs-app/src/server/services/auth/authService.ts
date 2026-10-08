import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getEnv } from '@/server/config/env'
import { logger } from '@/server/logger'
import { appendAuditBestEffort } from '@/server/services/audit/auditLog'
import { ROLES, type Role } from '@/types/domain'

const lockProfileSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  role: z.enum(ROLES),
  active: z.boolean(),
  locked_until: z.string().nullable(),
})

/** One generic failure for every login problem so responses never reveal whether an email exists. */
function invalidCredentials(): AppError {
  return new AppError('UNAUTHENTICATED', 'Invalid email or password.', {
    reason: 'INVALID_CREDENTIALS',
  })
}

/**
 * Password sign-in performed server-side so the lockout is enforced before credentials are checked:
 * 5 failures within 15 minutes lock the account for 15 minutes (counters live in `profiles`).
 * Sets the Supabase session cookies on success.
 */
export async function signInWithPassword(email: string, password: string): Promise<{ role: Role }> {
  const admin = getSupabaseAdmin()
  const { data: row, error: lookupError } = await admin
    .from('profiles')
    .select('id, org_id, role, active, locked_until')
    .eq('email', email)
    .maybeSingle()
  if (lookupError) {
    // Code and message only (for example "Invalid API key" or "relation does not exist"): never the request or any key.
    logger.error({ code: lookupError.code, message: lookupError.message, hint: lookupError.hint }, 'sign-in profile lookup failed')
    throw new AppError('INTERNAL', 'Sign-in is temporarily unavailable.', { cause: lookupError })
  }
  const profile = row ? lockProfileSchema.parse(row) : null

  if (profile?.locked_until && new Date(profile.locked_until) > new Date()) {
    await appendAuditBestEffort({
      orgId: profile.org_id,
      actor: { type: 'user', id: profile.id },
      event: 'auth.login_failed',
      payload: { reason: 'locked' },
    })
    throw invalidCredentials()
  }

  const supabase = createSupabaseServerClient()
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })

  if (error || !data.user) {
    if (profile) {
      const { error: rpcError } = await admin.rpc('record_login_failure', { p_email: email })
      if (rpcError) logger.error({ err: rpcError }, 'failed to record login failure')
      await appendAuditBestEffort({
        orgId: profile.org_id,
        actor: { type: 'user', id: profile.id },
        event: 'auth.login_failed',
        payload: { reason: 'bad_credentials' },
      })
    }
    throw invalidCredentials()
  }

  // The identity must map to an active profile; otherwise the fresh session is discarded.
  if (!profile || !profile.active || profile.id !== data.user.id) {
    await supabase.auth.signOut()
    if (profile) {
      await appendAuditBestEffort({
        orgId: profile.org_id,
        actor: { type: 'user', id: profile.id },
        event: 'auth.login_failed',
        payload: { reason: 'inactive' },
      })
    }
    throw invalidCredentials()
  }

  const { error: resetError } = await admin.rpc('reset_login_failures', { p_user: profile.id })
  if (resetError) logger.warn({ err: resetError }, 'failed to reset login failure counters')

  await appendAuditBestEffort({
    orgId: profile.org_id,
    actor: { type: 'user', id: profile.id },
    event: 'auth.login',
    payload: { method: 'password' },
  })
  return { role: profile.role }
}

/**
 * Sends a sign-in link. Never creates accounts (`shouldCreateUser: false`) and never reports whether
 * the address is known; delivery problems are logged, not surfaced.
 */
export async function sendMagicLink(email: string): Promise<void> {
  const supabase = createSupabaseServerClient()
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${getEnv().APP_BASE_URL}/auth/callback`,
    },
  })
  if (error) logger.warn({ err: error }, 'magic link request failed')
}
