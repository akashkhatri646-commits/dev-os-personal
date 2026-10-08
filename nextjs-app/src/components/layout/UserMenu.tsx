'use client'

import { ChevronDown, Loader2, LogOut } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { ROLE_LABEL } from '@/lib/auth/roles'
import { useCurrentUser } from '@/hooks/useRole'

interface UserMenuProps {
  onSignOut: () => Promise<void>
}

export function UserMenu({ onSignOut }: UserMenuProps) {
  const user = useCurrentUser()
  const [open, setOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    function handlePointer(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  async function handleSignOut() {
    setSigningOut(true)
    try {
      await onSignOut()
    } finally {
      setSigningOut(false)
    }
  }

  const displayName = user.fullName ?? user.email ?? 'Account'

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className="flex items-center gap-2 rounded-md px-2 py-1 text-body-lg text-text-primary transition-colors duration-fast ease-out hover:bg-bg-subtle"
      >
        <span className="hidden max-w-40 truncate sm:inline">{displayName}</span>
        <span className="badge-neutral">{ROLE_LABEL[user.role]}</span>
        <ChevronDown aria-hidden="true" className="h-4 w-4 text-text-secondary" />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-bg-primary p-1"
        >
          <div className="flex flex-col gap-0.5 border-b border-border px-3 py-2">
            <span className="truncate text-body-lg text-text-primary">{displayName}</span>
            {user.email && <span className="truncate text-body-sm text-text-secondary">{user.email}</span>}
            {user.orgName && <span className="truncate text-body-sm text-text-secondary">{user.orgName}</span>}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={handleSignOut}
            disabled={signingOut}
            className="mt-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-body-lg text-text-primary hover:bg-bg-subtle disabled:opacity-60"
          >
            {signingOut ? (
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            ) : (
              <LogOut aria-hidden="true" className="h-4 w-4" />
            )}
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
