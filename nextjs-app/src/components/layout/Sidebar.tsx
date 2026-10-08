'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronsLeft, ChevronsRight, X } from 'lucide-react'
import { navItemsForRole, type NavFeatures } from '@/components/layout/nav'
import { cn } from '@/lib/utils/cn'
import type { Role } from '@/types/domain'

interface SidebarProps {
  role: Role
  appName: string
  features: NavFeatures
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Mobile off-canvas state. */
  mobileOpen: boolean
  onCloseMobile: () => void
}

export function Sidebar({
  role,
  appName,
  features,
  collapsed,
  onToggleCollapsed,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const pathname = usePathname()
  const items = navItemsForRole(role, features)

  return (
    <>
      {mobileOpen && (
        <div
          aria-hidden="true"
          onClick={onCloseMobile}
          className="fixed inset-0 z-30 bg-text-primary opacity-40 md:hidden"
        />
      )}
      <aside
        aria-label="Primary"
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex flex-col border-r border-border bg-bg-primary transition-transform duration-panel ease-out md:static md:z-auto md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          collapsed ? 'md:w-16' : 'md:w-60',
          'w-60',
        )}
      >
        <div className="flex h-14 items-center justify-between gap-2 border-b border-border px-4">
          <span className={cn('truncate text-body-lg text-text-primary', collapsed && 'md:sr-only')}>
            {appName}
          </span>
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Close navigation"
            className="rounded-md p-1 text-text-secondary hover:bg-bg-subtle md:hidden"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>

        <nav aria-label="Main" className="flex-1 overflow-y-auto p-2">
          <ul className="flex flex-col gap-1">
            {items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
              const Icon = item.icon
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onCloseMobile}
                    aria-current={active ? 'page' : undefined}
                    title={collapsed ? item.label : undefined}
                    className={cn(
                      'flex items-center gap-3 rounded-md px-3 py-2 text-body-lg transition-colors duration-fast ease-out',
                      active
                        ? 'bg-brand-subtle text-brand'
                        : 'text-text-primary hover:bg-bg-subtle active:bg-bg-pressed',
                      collapsed && 'md:justify-center md:px-0',
                    )}
                  >
                    <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                    <span className={cn(collapsed && 'md:sr-only')}>{item.label}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="hidden border-t border-border p-2 md:block">
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            aria-expanded={!collapsed}
            className={cn(
              'flex w-full items-center gap-3 rounded-md px-3 py-2 text-body-sm text-text-secondary hover:bg-bg-subtle',
              collapsed && 'justify-center px-0',
            )}
          >
            {collapsed ? (
              <ChevronsRight aria-hidden="true" className="h-4 w-4" />
            ) : (
              <>
                <ChevronsLeft aria-hidden="true" className="h-4 w-4" />
                Collapse
              </>
            )}
          </button>
        </div>
      </aside>
    </>
  )
}
