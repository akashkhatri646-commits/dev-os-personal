import type { CookieOptions } from '@supabase/ssr'

/**
 * Sign-in cookies live only until the browser is closed: no max-age and no expiry, so opening the app
 * again shows the sign-in page. Applied everywhere the session cookies are written.
 */
export function sessionCookieOptions(options: CookieOptions | undefined): CookieOptions {
  // `expires` is dropped on purpose (session cookie). Cookies are Secure in production, so they never travel over plain HTTP.
  const { maxAge, expires: _expires, ...rest } = options ?? {}
  // A cookie being removed must keep its expiry (maxAge 0), or it would never be deleted.
  const secure = process.env.NODE_ENV === 'production'
  return maxAge === 0 ? { ...rest, secure, maxAge: 0 } : { ...rest, secure }
}
