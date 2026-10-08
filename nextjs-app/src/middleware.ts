import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { canAccessPage, isPublicPath } from '@/lib/auth/pageAccess'
import { ROLE_HOME } from '@/lib/auth/roles'
import { sessionCookieOptions } from '@/lib/supabase/sessionCookies'
import { ROLES, type Role } from '@/types/domain'

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/** Redirect that keeps any session cookies Supabase refreshed during this request. */
function redirectWithCookies(request: NextRequest, source: NextResponse, path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, request.url))
  for (const cookie of source.cookies.getAll()) response.cookies.set(cookie)
  return response
}

/**
 * Session refresh and page-level access control (spec 01 §3).
 * - Unauthenticated users are sent to /login?next=<path>.
 * - Users without an active profile are treated as unauthenticated.
 * - /login is never skipped: it always shows the sign-in form.
 * - A role that may not open the page is redirected to its home page.
 * The role is read from `profiles` on every page request (no cached role), so changes apply at once.
 * API routes enforce authentication themselves and are not intercepted here.
 */
export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const isPublic = isPublicPath(pathname)
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (isPublic && pathname !== '/login') return NextResponse.next({ request })

  // Without Supabase configuration nobody can hold a session: only /login is reachable.
  if (!supabaseUrl || !supabaseAnonKey) {
    return pathname === '/login'
      ? NextResponse.next({ request })
      : NextResponse.redirect(new URL('/login?error=not_configured', request.url))
  }

  let response = NextResponse.next({ request })
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, sessionCookieOptions(options))
      },
    },
  })

  const { data: authData } = await supabase.auth.getUser()
  let role: Role | null = null
  if (authData.user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, active')
      .eq('id', authData.user.id)
      .maybeSingle()
    if (profile?.active === true && isRole(profile.role)) role = profile.role
  }

  // The sign-in page always shows the form, even when a session exists: signing in again replaces that session.
  if (pathname === '/login') return response

  if (!role) {
    const next = encodeURIComponent(`${pathname}${search}`)
    return redirectWithCookies(request, response, `/login?next=${next}`)
  }

  if (!canAccessPage(role, pathname)) {
    return redirectWithCookies(request, response, ROLE_HOME[role])
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
}
