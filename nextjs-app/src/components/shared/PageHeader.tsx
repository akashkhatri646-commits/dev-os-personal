import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

interface PageHeaderProps {
  title: string
  description?: string
  /** Right-aligned actions (buttons/links). */
  actions?: ReactNode
  className?: string
}

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-h4 text-text-primary">{title}</h1>
        {description && <p className="max-w-2xl text-body-sm text-text-secondary">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
