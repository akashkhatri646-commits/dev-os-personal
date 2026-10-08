import { Inbox } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

interface EmptyStateProps {
  title: string
  description?: string
  /** Primary call to action, e.g. a link or button. */
  action?: ReactNode
  className?: string
}

export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border border-border bg-bg-primary px-6 py-12 text-center',
        className,
      )}
    >
      <Inbox aria-hidden="true" className="h-6 w-6 text-text-secondary" />
      <div className="flex flex-col gap-0.5">
        <p className="text-body-lg text-text-primary">{title}</p>
        {description && <p className="max-w-md text-body-sm text-text-secondary">{description}</p>}
      </div>
      {action}
    </div>
  )
}
