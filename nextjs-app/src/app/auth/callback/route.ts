import { NextResponse, type NextRequest } from 'next/server'
import { ROLE_HOME } from '@/lib/auth/roles'
import { safeRedirectPath } from '@/lib/auth/safeRedirect'
import { getAuthUser } from '@/lib/auth/withAuth'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { getEnv } from '@/server/config/env'
import { appendAuditBestEffort } from '@/server/services/audit/auditLog'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function redirectTo(path: string): NextResponse {
  return NextResponse.redirect(new URL(path, getEnv().APP_BASE_URL))
}

/**
 * Completes email-link sign-in and invitations: exchanges the one-time code for a session, then
 * only keeps the session if it belongs to an active profile.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  if (!code) return redirectTo('/login?error=link_invalid')

  const supabase = createSupabaseServerClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) return redirectTo('/login?error=link_invalid')

  const user = await getAuthUser()
  if (!user) {
    await supabase.auth.signOut()
    return redirectTo('/login?error=no_access')
  }

  await appendAuditBestEffort({
    orgId: user.orgId,
    actor: { type: 'user', id: user.userId },
    event: 'auth.login',
    payload: { method: 'email_link' },
  })
  return redirectTo(safeRedirectPath(request.nextUrl.searchParams.get('next'), ROLE_HOME[user.role]))
}
