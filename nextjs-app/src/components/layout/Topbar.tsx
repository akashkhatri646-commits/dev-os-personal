'use client'

import { Menu } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { UserMenu } from '@/components/layout/UserMenu'

interface TopbarProps {
  onOpenNavigation: () => void
  onSignOut: () => Promise<void>
}

const SEGMENT_LABELS: Record<string, string> = {
  admin: 'Admin',
  audit: 'Audit',
  dashboard: 'Dashboard',
  ingest: 'Ingest',
  records: 'Records',
  review: 'Review queue',
  settings: 'Settings',
  sources: 'Sources',
  thresholds: 'Thresholds',
  system: 'System check',
  users: 'Users',
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function labelFor(segment: string): string {
  if (UUID_PATTERN.test(segment)) return 'Details'
  return SEGMENT_LABELS[segment] ?? segment.replaceAll('-', ' ').replace(/^\w/, (char) => char.toUpperCase())
}

export function Topbar({ onOpenNavigation, onSignOut }: TopbarProps) {
  const pathname = usePathname()
  const segments = pathname.split('/').filter(Boolean)

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-bg-primary px-4">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onOpenNavigation}
          aria-label="Open navigation"
          className="rounded-md p-2 text-text-primary hover:bg-bg-subtle md:hidden"
        >
          <Menu aria-hidden="true" className="h-4 w-4" />
        </button>
        <nav aria-label="Breadcrumb" className="min-w-0">
          <ol className="flex items-center gap-2 text-body-sm text-text-secondary">
            {segments.map((segment, index) => {
              const href = `/${segments.slice(0, index + 1).join('/')}`
              const last = index === segments.length - 1
              return (
                <li key={href} className="flex min-w-0 items-center gap-2">
                  {index > 0 && <span aria-hidden="true">/</span>}
                  {last ? (
                    <span aria-current="page" className="truncate text-text-primary">
                      {labelFor(segment)}
                    </span>
                  ) : (
                    <Link href={href} className="truncate hover:text-text-primary">
                      {labelFor(segment)}
                    </Link>
                  )}
                </li>
              )
            })}
          </ol>
        </nav>
      </div>
      <UserMenu onSignOut={onSignOut} />
    </header>
  )
}
