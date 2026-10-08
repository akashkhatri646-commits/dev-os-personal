import { hasRole } from '@/lib/auth/roles'
import type { Role } from '@/types/domain'

interface PageRule {
  prefix: string
  roles: readonly Role[]
}

/** Role guard for pages (docs/specs/01-auth-roles-rls.md §3). The longest matching prefix wins. */
const PAGE_RULES: readonly PageRule[] = [
  { prefix: '/ingest', roles: ['integration_engineer', 'admin'] },
  { prefix: '/records', roles: ['integration_engineer', 'reviewer', 'admin'] },
  { prefix: '/review', roles: ['reviewer', 'admin'] },
  { prefix: '/sources', roles: ['integration_engineer', 'admin'] },
  { prefix: '/settings/thresholds', roles: ['integration_engineer', 'admin'] },
  { prefix: '/dashboard', roles: ['integration_engineer', 'reviewer', 'admin', 'viewer'] },
  { prefix: '/audit', roles: ['admin'] },
  { prefix: '/incidents', roles: ['admin'] },
  { prefix: '/admin', roles: ['admin'] },
]

/** Paths reachable without a session. API routes authenticate themselves and are not handled here. */
const PUBLIC_EXACT = ['/', '/login'] as const
const PUBLIC_PREFIXES = ['/login/', '/auth/', '/api/'] as const

export function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_EXACT.some((path) => path === pathname) ||
    PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  )
}

function matchRule(pathname: string): PageRule | undefined {
  return PAGE_RULES.filter(
    (rule) => pathname === rule.prefix || pathname.startsWith(`${rule.prefix}/`),
  ).sort((a, b) => b.prefix.length - a.prefix.length)[0]
}

/** True when `role` may open `pathname`. Paths without a rule only need a session. */
export function canAccessPage(role: Role, pathname: string): boolean {
  const rule = matchRule(pathname)
  return rule ? hasRole(role, rule.roles) : true
}
