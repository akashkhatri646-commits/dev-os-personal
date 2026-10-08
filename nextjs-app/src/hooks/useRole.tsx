'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { AuthUser, Role } from '@/types/domain'

type ClientUser = Omit<AuthUser, 'accessToken'>

const RoleContext = createContext<ClientUser | null>(null)

export function RoleProvider({ user, children }: { user: ClientUser; children: ReactNode }) {
  return <RoleContext.Provider value={user}>{children}</RoleContext.Provider>
}

/** The signed-in user (without tokens). Use for UI gating only: the server enforces permissions. */
export function useCurrentUser(): ClientUser {
  const user = useContext(RoleContext)
  if (!user) throw new Error('useCurrentUser must be used within RoleProvider')
  return user
}

export function useRole(): Role {
  return useCurrentUser().role
}
