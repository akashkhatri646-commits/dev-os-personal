'use client'

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { UserPlus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { InviteUserDialog } from '@/components/admin/InviteUserDialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { DataTable } from '@/components/shared/DataTable'
import { PageHeader } from '@/components/shared/PageHeader'
import { useToast } from '@/components/ui/Toaster'
import { useCurrentUser } from '@/hooks/useRole'
import { apiFetch } from '@/lib/api/client'
import { queryKeys } from '@/lib/api/queryKeys'
import { ROLE_LABEL } from '@/lib/auth/roles'
import { ROLES, type Role, type UserSummary } from '@/types/domain'

type PendingChange =
  | { kind: 'role'; user: UserSummary; role: Role }
  | { kind: 'active'; user: UserSummary; active: boolean }

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function displayName(user: UserSummary): string {
  return user.full_name ?? user.email
}

async function fetchUsersPage(cursor: string | undefined) {
  const params = new URLSearchParams({ limit: '25' })
  if (cursor) params.set('cursor', cursor)
  const { data, meta } = await apiFetch<UserSummary[]>(`/api/admin/users?${params.toString()}`)
  return { users: data, nextCursor: meta?.next_cursor ?? null }
}

export function UsersView() {
  const currentUser = useCurrentUser()
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [inviteOpen, setInviteOpen] = useState(false)
  const [pending, setPending] = useState<PendingChange | null>(null)

  const query = useInfiniteQuery({
    queryKey: queryKeys.users,
    queryFn: ({ pageParam }) => fetchUsersPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })

  const users = useMemo(() => query.data?.pages.flatMap((page) => page.users) ?? [], [query.data])

  const columns = useMemo<ColumnDef<UserSummary, unknown>[]>(
    () => [
      {
        id: 'name',
        header: 'User',
        accessorFn: (user) => displayName(user),
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <span className="text-body-lg text-text-primary">{displayName(row.original)}</span>
            <span className="text-body-sm text-text-secondary">{row.original.email}</span>
          </div>
        ),
      },
      {
        id: 'role',
        header: 'Role',
        accessorKey: 'role',
        cell: ({ row }) => {
          const user = row.original
          const isSelf = user.id === currentUser.userId
          return (
            <select
              aria-label={`Role for ${displayName(user)}`}
              value={user.role}
              disabled={isSelf}
              title={isSelf ? 'You cannot change your own role' : undefined}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => setPending({ kind: 'role', user, role: event.target.value as Role })}
              className="rounded-md border border-border bg-bg-primary px-2 py-1 text-body-sm text-text-primary focus:border-border-brand disabled:cursor-not-allowed disabled:bg-bg-surface disabled:text-text-disabled"
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABEL[role]}
                </option>
              ))}
            </select>
          )
        },
      },
      {
        id: 'status',
        header: 'Status',
        accessorKey: 'active',
        cell: ({ row }) => {
          const user = row.original
          const isSelf = user.id === currentUser.userId
          return (
            <div className="flex items-center gap-3">
              <span className={user.active ? 'badge-success' : 'badge-neutral'}>
                {user.active ? 'Active' : 'Inactive'}
              </span>
              <button
                type="button"
                disabled={isSelf}
                title={isSelf ? 'You cannot deactivate yourself' : undefined}
                onClick={(event) => {
                  event.stopPropagation()
                  setPending({ kind: 'active', user, active: !user.active })
                }}
                className="rounded-sm text-body-sm text-brand hover:underline disabled:cursor-not-allowed disabled:text-text-disabled disabled:no-underline"
              >
                {user.active ? 'Deactivate' : 'Reactivate'}
              </button>
            </div>
          )
        },
      },
      {
        id: 'last_sign_in',
        header: 'Last sign-in',
        accessorKey: 'last_sign_in_at',
        cell: ({ row }) => (
          <span className="text-text-secondary">
            {row.original.last_sign_in_at ? dateFormatter.format(new Date(row.original.last_sign_in_at)) : 'Never'}
          </span>
        ),
      },
    ],
    [currentUser.userId],
  )

  async function confirmChange() {
    if (!pending) return
    const body =
      pending.kind === 'role' ? { role: pending.role } : { active: pending.active }
    await apiFetch(`/api/admin/users/${pending.user.id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
    await queryClient.invalidateQueries({ queryKey: queryKeys.users })
    toast({
      title: pending.kind === 'role' ? 'Role updated' : pending.active ? 'User reactivated' : 'User deactivated',
      description: displayName(pending.user),
      tone: 'success',
    })
  }

  const dialogCopy = (() => {
    if (!pending) return null
    if (pending.kind === 'role') {
      return {
        title: `Change role to ${ROLE_LABEL[pending.role]}?`,
        description: `${displayName(pending.user)} will have ${ROLE_LABEL[pending.role]} permissions on their next request.`,
        confirmLabel: 'Change role',
        destructive: false,
      }
    }
    return pending.active
      ? {
          title: 'Reactivate this user?',
          description: `${displayName(pending.user)} will be able to sign in again.`,
          confirmLabel: 'Reactivate',
          destructive: false,
        }
      : {
          title: 'Deactivate this user?',
          description: `${displayName(pending.user)} will be signed out on their next request and cannot sign in until reactivated.`,
          confirmLabel: 'Deactivate',
          destructive: true,
        }
  })()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Users"
        description="Invite staff and manage their roles. Changes take effect on the user's next request."
        actions={
          <button type="button" className="btn-primary" onClick={() => setInviteOpen(true)}>
            <UserPlus aria-hidden="true" className="h-4 w-4" />
            Invite user
          </button>
        }
      />

      <DataTable
        caption="Users in your organisation"
        columns={columns}
        data={users}
        getRowId={(user) => user.id}
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyTitle="No users yet"
        emptyDescription="Invite the first teammate to get started."
        hasMore={query.hasNextPage}
        onLoadMore={() => void query.fetchNextPage()}
        isLoadingMore={query.isFetchingNextPage}
      />

      <InviteUserDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={(email) => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.users })
          toast({ title: 'Invitation sent', description: email, tone: 'success' })
        }}
      />

      {dialogCopy && (
        <ConfirmDialog
          open={pending !== null}
          onOpenChange={(open) => {
            if (!open) setPending(null)
          }}
          title={dialogCopy.title}
          description={dialogCopy.description}
          confirmLabel={dialogCopy.confirmLabel}
          destructive={dialogCopy.destructive}
          onConfirm={confirmChange}
        />
      )}
    </div>
  )
}
