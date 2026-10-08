import {
  ClipboardCheck,
  Database,
  OctagonAlert,
  FileText,
  LayoutDashboard,
  ScrollText,
  ShieldCheck,
  Upload,
  Stethoscope,
  Users,
  type LucideIcon,
} from 'lucide-react'
import type { Role } from '@/types/domain'

/** Deployment features that can hide a navigation entry. */
export interface NavFeatures {
  /** True while the consent ledger is the built-in stub (CONSENT_MODE=stub). */
  consentStub?: boolean
}

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  roles: readonly Role[]
  /** Only shown when this deployment feature is on. */
  feature?: keyof NavFeatures
}

/** Single source of truth for navigation and per-role visibility (spec 11 §3, spec 01 §3). */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/ingest', label: 'Ingest', icon: Upload, roles: ['integration_engineer', 'admin'] },
  {
    href: '/records',
    label: 'Records',
    icon: FileText,
    roles: ['integration_engineer', 'reviewer', 'admin'],
  },
  { href: '/review', label: 'Review queue', icon: ClipboardCheck, roles: ['reviewer', 'admin'] },
  { href: '/sources', label: 'Sources', icon: Database, roles: ['integration_engineer', 'admin'] },
  {
    href: '/dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    roles: ['integration_engineer', 'reviewer', 'admin', 'viewer'],
  },
  { href: '/incidents', label: 'Incidents', icon: OctagonAlert, roles: ['admin'] },
  { href: '/audit', label: 'Audit', icon: ScrollText, roles: ['admin'] },
  { href: '/admin/users', label: 'Users', icon: Users, roles: ['admin'] },
  { href: '/admin/system', label: 'System check', icon: Stethoscope, roles: ['admin'] },
  { href: '/admin/consent', label: 'Consent (stub)', icon: ShieldCheck, roles: ['admin'], feature: 'consentStub' },
]

export function navItemsForRole(role: Role, features: NavFeatures = {}): NavItem[] {
  return NAV_ITEMS.filter(
    (item) => item.roles.includes(role) && (item.feature === undefined || features[item.feature] === true),
  )
}
