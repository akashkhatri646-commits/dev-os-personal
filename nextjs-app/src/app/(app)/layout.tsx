import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { AppShell } from '@/components/layout/AppShell'
import { getPublicEnv } from '@/lib/publicEnv'
import { getAuthUser } from '@/lib/auth/withAuth'
import { getEnv } from '@/server/config/env'
import { getSystemBanners } from '@/server/services/safety/banners'

// Every page in this group needs a live session, so it is always rendered per request.
export const dynamic = 'force-dynamic'

export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const user = await getAuthUser()
  if (!user) redirect('/login')

  // Tokens never reach the client; the shell only receives the display fields it needs.
  const { accessToken: _accessToken, ...clientUser } = user
  const banners = await getSystemBanners(user)
  return (
    <AppShell
      user={clientUser}
      appName={getPublicEnv().appName}
      features={{ consentStub: getEnv().CONSENT_MODE === 'stub' }}
      banners={banners}
    >
      {children}
    </AppShell>
  )
}
