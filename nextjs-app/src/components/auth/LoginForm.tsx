'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, MailCheck } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { TextField } from '@/components/ui/fields'
import { apiFetch } from '@/lib/api/client'
import { ApiError } from '@/lib/api/errors'
import { safeRedirectPath } from '@/lib/auth/safeRedirect'
import {
  loginSchema,
  magicLinkSchema,
  type LoginInput,
  type MagicLinkInput,
} from '@/lib/validation/auth'
import { cn } from '@/lib/utils/cn'
import type { z } from 'zod'

interface LoginFormProps {
  nextPath: string | null
  initialError: string | null
}

type Mode = 'password' | 'link'

function signInErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'UNAUTHENTICATED') {
      return 'Invalid email or password. After several failed attempts the account is locked for 15 minutes.'
    }
    if (error.code === 'RATE_LIMITED') return 'Too many attempts. Wait a minute and try again.'
    if (error.code === 'NETWORK') return error.message
  }
  return 'Sign-in is unavailable right now. Try again shortly.'
}

export function LoginForm({ nextPath, initialError }: LoginFormProps) {
  const [mode, setMode] = useState<Mode>('password')

  return (
    <div className="flex flex-col gap-6 rounded-xl border border-border bg-bg-primary p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h5 text-text-primary">Sign in</h1>
        <p className="text-body-sm text-text-secondary">
          Trust at the Edge — agentic health record ingestion.
        </p>
      </div>

      {initialError && (
        <p
          role="alert"
          className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-body-sm text-danger-text"
        >
          {initialError}
        </p>
      )}

      {mode === 'password' ? <PasswordForm nextPath={nextPath} /> : <MagicLinkForm />}

      <button
        type="button"
        onClick={() => setMode(mode === 'password' ? 'link' : 'password')}
        className="self-start rounded-sm text-body-sm text-brand hover:underline"
      >
        {mode === 'password' ? 'Email me a sign-in link instead' : 'Use my password instead'}
      </button>
    </div>
  )
}

function PasswordForm({ nextPath }: { nextPath: string | null }) {
  const router = useRouter()
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<z.input<typeof loginSchema>, unknown, LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  })

  async function onSubmit(values: LoginInput) {
    setFormError(null)
    try {
      const { data } = await apiFetch<{ role: string; redirect_to: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(values),
      })
      router.replace(safeRedirectPath(nextPath, data.redirect_to))
      router.refresh()
    } catch (error) {
      setFormError(signInErrorMessage(error))
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
      <TextField
        label="Email"
        type="email"
        autoComplete="username"
        inputMode="email"
        error={errors.email?.message}
        {...register('email')}
      />
      <TextField
        label="Password"
        type="password"
        autoComplete="current-password"
        error={errors.password?.message}
        {...register('password')}
      />
      {formError && (
        <p
          role="alert"
          className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-body-sm text-danger-text"
        >
          {formError}
        </p>
      )}
      <button type="submit" disabled={isSubmitting} className={cn('btn-primary', isSubmitting && 'opacity-60')}>
        {isSubmitting && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
        Sign in
      </button>
    </form>
  )
}

function MagicLinkForm() {
  const [sent, setSent] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<z.input<typeof magicLinkSchema>, unknown, MagicLinkInput>({
    resolver: zodResolver(magicLinkSchema),
    defaultValues: { email: '' },
  })

  async function onSubmit(values: MagicLinkInput) {
    setFormError(null)
    try {
      await apiFetch('/api/auth/magic-link', { method: 'POST', body: JSON.stringify(values) })
      setSent(true)
    } catch (error) {
      setFormError(
        error instanceof ApiError && error.code === 'RATE_LIMITED'
          ? 'Too many requests. Wait a minute and try again.'
          : 'Could not send the link right now. Try again shortly.',
      )
    }
  }

  if (sent) {
    return (
      <div
        role="status"
        className="flex items-start gap-3 rounded-md border border-success-border bg-success-bg px-3 py-3 text-body-sm text-success-text"
      >
        <MailCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        If that address belongs to an active account, a sign-in link is on its way. The link works once
        and expires shortly.
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
      <TextField
        label="Email"
        type="email"
        autoComplete="email"
        inputMode="email"
        error={errors.email?.message}
        {...register('email')}
      />
      {formError && (
        <p
          role="alert"
          className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-body-sm text-danger-text"
        >
          {formError}
        </p>
      )}
      <button type="submit" disabled={isSubmitting} className={cn('btn-primary', isSubmitting && 'opacity-60')}>
        {isSubmitting && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
        Email me a sign-in link
      </button>
    </form>
  )
}
