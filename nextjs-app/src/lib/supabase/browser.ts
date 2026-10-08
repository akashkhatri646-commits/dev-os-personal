import { createBrowserClient, parse, serialize } from '@supabase/ssr'
import { getPublicEnv } from '@/lib/publicEnv'
import { sessionCookieOptions } from '@/lib/supabase/sessionCookies'

/** Browser Supabase client (anon key). The session is kept in cookies that end when the browser closes. Subject to RLS. */
export function createSupabaseBrowserClient() {
  const { supabaseUrl, supabaseAnonKey } = getPublicEnv()
  return createBrowserClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll: () => Object.entries(parse(document.cookie)).map(([name, value]) => ({ name, value: value ?? '' })),
      setAll: (cookiesToSet) => {
        for (const { name, value, options } of cookiesToSet) document.cookie = serialize(name, value, sessionCookieOptions(options))
      },
    },
  })
}
