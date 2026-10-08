// Public (browser-safe) configuration. Each NEXT_PUBLIC_* variable must be referenced literally
// so Next.js can inline it at build time. Never put secrets in this file.

export interface PublicEnv {
  supabaseUrl: string
  supabaseAnonKey: string
  appName: string
}

export function getPublicEnv(): PublicEnv {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. Set them in .env.local.',
    )
  }
  return {
    supabaseUrl,
    supabaseAnonKey,
    appName: process.env.NEXT_PUBLIC_APP_NAME || 'Trust at the Edge',
  }
}
