import type { Role } from '@/types/domain'

export const ROLE_LABEL: Record<Role, string> = {
  integration_engineer: 'Integration engineer',
  reviewer: 'Reviewer',
  admin: 'Admin',
  viewer: 'Viewer',
}

/** Landing page after sign-in and redirect target for disallowed routes (spec 01 §3). */
export const ROLE_HOME: Record<Role, string> = {
  integration_engineer: '/dashboard',
  reviewer: '/dashboard',
  admin: '/dashboard',
  viewer: '/dashboard',
}

export function hasRole(role: Role | null | undefined, allowed: readonly Role[]): boolean {
  return role != null && allowed.includes(role)
}
