'use client'

import type { ReactNode } from 'react'
import { hasRole } from '@/lib/auth/roles'
import { useRole } from '@/hooks/useRole'
import type { Role } from '@/types/domain'

interface RoleGateProps {
  allow: readonly Role[]
  children: ReactNode
  /** Rendered when the role is not allowed. Defaults to nothing. */
  fallback?: ReactNode
}

/** Hides UI by role. This is a convenience only; every API route enforces roles on the server. */
export function RoleGate({ allow, children, fallback = null }: RoleGateProps) {
  const role = useRole()
  return hasRole(role, allow) ? <>{children}</> : <>{fallback}</>
}
