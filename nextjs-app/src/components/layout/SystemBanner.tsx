import { Info, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

export interface SystemBannerMessage {
  id: string
  tone: 'info' | 'warning' | 'danger'
  message: string
}

const TONE_CLASS: Record<SystemBannerMessage['tone'], string> = {
  info: 'border-info-border bg-info-bg text-info-text',
  warning: 'border-warning-border bg-warning-bg text-warning-text',
  danger: 'border-danger-border bg-danger-bg text-danger-text',
}

/**
 * Global banner slot under the top bar (consent service degraded, paused sources, audit integrity failure).
 * Features feed it messages through the app layout; renders nothing when there are none.
 */
export function SystemBanner({ banners }: { banners: readonly SystemBannerMessage[] }) {
  if (banners.length === 0) return null
  return (
    <div className="flex flex-col" role="status" aria-live="polite">
      {banners.map((banner) => {
        const Icon = banner.tone === 'info' ? Info : TriangleAlert
        return (
          <div
            key={banner.id}
            className={cn('flex items-center gap-2 border-b px-4 py-2 text-body-sm', TONE_CLASS[banner.tone])}
          >
            <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
            {banner.message}
          </div>
        )
      })}
    </div>
  )
}
