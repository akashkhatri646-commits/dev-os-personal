import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { hasRole } from '@/lib/auth/roles'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { ROLES, type AuthUser, type Role } from '@/types/domain'

const profileRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  full_name: z.string().nullable(),
  role: z.enum(ROLES),
  active: z.boolean(),
  organizations: z
    .union([z.object({ name: z.string() }), z.array(z.object({ name: z.string() }))])
    .nullable(),
})

function bearerToken(request?: Request): string | undefined {
  const header = request?.headers.get('authorization')
  if (!header) return undefined
  const [scheme, token] = header.split(' ')
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined
}

/**
 * Resolves the current user from the Supabase session (cookies) or a Bearer token and loads the
 * active profile. Returns null when unauthenticated or when the profile is missing/inactive,
 * so a deactivated user fails closed on the very next request.
 *
 * The role is always read from the `profiles` table, never from JWT claims, so role changes
 * take effect immediately.
 */
export async function getAuthUser(request?: Request): Promise<AuthUser | null> {
  const accessToken = bearerToken(request)
  const supabase = createSupabaseServerClient(accessToken)
  const { data, error } = await supabase.auth.getUser(accessToken)
  if (error || !data.user) return null

  const { data: row, error: profileError } = await getSupabaseAdmin()
    .from('profiles')
    .select('id, org_id, full_name, role, active, organizations(name)')
    .eq('id', data.user.id)
    .maybeSingle()
  if (profileError || !row) return null

  const profile = profileRowSchema.safeParse(row)
  if (!profile.success || !profile.data.active) return null

  const org = profile.data.organizations
  const orgName = Array.isArray(org) ? (org[0]?.name ?? null) : (org?.name ?? null)

  return {
    userId: data.user.id,
    email: data.user.email ?? null,
    orgId: profile.data.org_id,
    orgName,
    fullName: profile.data.full_name,
    role: profile.data.role,
    accessToken,
  }
}

/** Like `getAuthUser` but throws `UNAUTHENTICATED` (401) when there is no active user. */
export async function requireUser(request?: Request): Promise<AuthUser> {
  const user = await getAuthUser(request)
  if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
  return user
}

/** Throws `FORBIDDEN` (403) unless the user's role is in `roles`. */
export function requireRole(user: AuthUser, roles: readonly Role[]): void {
  if (!hasRole(user.role, roles)) {
    throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.')
  }
}
