'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { NavFeatures } from '@/components/layout/nav'
import { Providers } from '@/components/layout/Providers'
import { Sidebar } from '@/components/layout/Sidebar'
import { SystemBanner, type SystemBannerMessage } from '@/components/layout/SystemBanner'
import { Topbar } from '@/components/layout/Topbar'
import { RoleProvider } from '@/hooks/useRole'
import { onUnauthenticated } from '@/lib/api/client'
import { createSupabaseBrowserClient } from '@/lib/supabase/browser'
import type { AuthUser } from '@/types/domain'

const COLLAPSED_KEY = 'sidebar-collapsed'

interface AppShellProps {
  user: Omit<AuthUser, 'accessToken'>
  appName: string
  features?: NavFeatures
  banners?: readonly SystemBannerMessage[]
  children: ReactNode
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

function writeCollapsed(value: boolean) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, String(value))
  } catch {
    // Storage can be unavailable (private mode); the preference simply is not remembered.
  }
}

export function AppShell({ user, appName, features = {}, banners = [], children }: AppShellProps) {
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    setCollapsed(readCollapsed())
  }, [])

  const signOut = useCallback(async () => {
    try {
      // The server clears the session cookies and records the sign-out; the browser client then drops its own copy.
      await fetch('/api/auth/logout', { method: 'POST' })
      await createSupabaseBrowserClient().auth.signOut({ scope: 'local' })
    } catch {
      // Offline or already signed out: still leave the app.
    }
    router.replace('/login')
    router.refresh()
  }, [router])

  // Any 401 from the API (expired session, deactivated user) signs the user out (spec 11 §5).
  useEffect(() => {
    onUnauthenticated(() => {
      void signOut()
    })
    return () => onUnauthenticated(null)
  }, [signOut])

  function toggleCollapsed() {
    setCollapsed((current) => {
      writeCollapsed(!current)
      return !current
    })
  }

  return (
    <RoleProvider user={user}>
      <Providers>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-bg-primary focus:px-3 focus:py-2"
        >
          Skip to main content
        </a>
        <div className="flex min-h-screen bg-bg-surface">
          <Sidebar
            role={user.role}
            appName={appName}
            features={features}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            mobileOpen={mobileOpen}
            onCloseMobile={() => setMobileOpen(false)}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar onOpenNavigation={() => setMobileOpen(true)} onSignOut={signOut} />
            <SystemBanner banners={banners} />
            <main id="main" tabIndex={-1} className="flex-1 p-4 outline-none md:p-8">
              {children}
            </main>
          </div>
        </div>
      </Providers>
    </RoleProvider>
  )
}
