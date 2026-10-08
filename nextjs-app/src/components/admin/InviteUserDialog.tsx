'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import type { z } from 'zod'
import { SelectField, TextField } from '@/components/ui/fields'
import { apiFetch } from '@/lib/api/client'
import { ApiError } from '@/lib/api/errors'
import { ROLE_LABEL } from '@/lib/auth/roles'
import { inviteUserSchema, type InviteUserInput } from '@/lib/validation/auth'
import { ROLES } from '@/types/domain'

interface InviteUserDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInvited: (email: string) => void
}

const ROLE_OPTIONS = ROLES.map((role) => ({ value: role, label: ROLE_LABEL[role] }))

export function InviteUserDialog({ open, onOpenChange, onInvited }: InviteUserDialogProps) {
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<z.input<typeof inviteUserSchema>, unknown, InviteUserInput>({
    resolver: zodResolver(inviteUserSchema),
    defaultValues: { email: '', full_name: '', role: 'reviewer' },
  })

  function handleOpenChange(next: boolean) {
    if (isSubmitting) return
    if (!next) {
      reset()
      setFormError(null)
    }
    onOpenChange(next)
  }

  async function onSubmit(values: InviteUserInput) {
    setFormError(null)
    try {
      await apiFetch('/api/admin/users', { method: 'POST', body: JSON.stringify(values) })
      onInvited(values.email)
      reset()
      onOpenChange(false)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') {
        setError('email', { message: 'A user with this email already exists.' })
        return
      }
      setFormError(error instanceof ApiError ? error.message : 'Could not send the invitation.')
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-text-primary opacity-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-primary p-6">
          <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-h5 text-text-primary">Invite user</Dialog.Title>
              <Dialog.Description className="text-body-sm text-text-secondary">
                They receive an email with a sign-in link and join your organisation with the role below.
              </Dialog.Description>
            </div>

            <TextField
              label="Email"
              type="email"
              autoComplete="off"
              inputMode="email"
              error={errors.email?.message}
              {...register('email')}
            />
            <TextField
              label="Full name"
              autoComplete="off"
              error={errors.full_name?.message}
              {...register('full_name')}
            />
            <SelectField
              label="Role"
              options={ROLE_OPTIONS}
              error={errors.role?.message}
              {...register('role')}
            />

            {formError && (
              <p
                role="alert"
                className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-body-sm text-danger-text"
              >
                {formError}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <button type="button" className="btn-secondary" disabled={isSubmitting}>
                  Cancel
                </button>
              </Dialog.Close>
              <button type="submit" className="btn-primary disabled:opacity-60" disabled={isSubmitting}>
                {isSubmitting && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
                Send invitation
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
