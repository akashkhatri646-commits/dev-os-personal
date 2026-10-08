import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getEnv } from '@/server/config/env'

let adminClient: SupabaseClient | undefined

/**
 * Service-role client. BYPASSES Row Level Security: use only for pipeline/worker writes, audit
 * inserts and privileged mutations after an explicit role and org check in the calling handler.
 * Never import this from client components or return its results unfiltered.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (adminClient) return adminClient
  const env = getEnv()
  adminClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return adminClient
}
