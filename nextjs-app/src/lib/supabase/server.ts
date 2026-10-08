import 'server-only'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getPublicEnv } from '@/lib/publicEnv'
import { sessionCookieOptions } from '@/lib/supabase/sessionCookies'

/**
 * User-scoped Supabase client for server code; Row Level Security applies.
 * - With `accessToken` (Authorization: Bearer callers) the token is forwarded and no cookies are used.
 * - Otherwise the session is read from, and refreshed into, the request cookies.
 */
export function createSupabaseServerClient(accessToken?: string): SupabaseClient {
  const { supabaseUrl, supabaseAnonKey } = getPublicEnv()

  if (accessToken) {
    return createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    })
  }

  const cookieStore = cookies()
  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, sessionCookieOptions(options))
          }
        } catch {
          // Called from a Server Component where cookies are read-only; the middleware
          // refreshes the session, so ignoring is safe.
        }
      },
    },
  })
}
