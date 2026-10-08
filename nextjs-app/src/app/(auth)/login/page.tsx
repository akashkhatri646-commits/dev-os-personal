import type { Metadata } from 'next'
import { LoginForm } from '@/components/auth/LoginForm'

export const metadata: Metadata = { title: 'Sign in — Trust at the Edge' }

const ERROR_MESSAGES: Record<string, string> = {
  link_invalid: 'That sign-in link is invalid or has expired. Request a new one below.',
  no_access: 'Your account is not active in this system. Contact an administrator.',
  not_configured: 'The server is not configured yet: Supabase environment variables are missing.',
}

interface LoginPageProps {
  searchParams: { next?: string; error?: string }
}

export default function LoginPage({ searchParams }: LoginPageProps) {
  const initialError = searchParams.error ? (ERROR_MESSAGES[searchParams.error] ?? null) : null
  return <LoginForm nextPath={searchParams.next ?? null} initialError={initialError} />
}
