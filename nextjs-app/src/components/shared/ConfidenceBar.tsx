import { CheckCircle2, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

interface ConfidenceBarProps {
  /** Score from 0 to 1. */
  score: number
  /** Routing threshold from 0 to 1; draws a tick and a text status when provided. */
  threshold?: number
  className?: string
}

const clamp = (value: number) => Math.min(1, Math.max(0, value))

export function ConfidenceBar({ score, threshold, className }: ConfidenceBarProps) {
  const safeScore = Number.isFinite(score) ? clamp(score) : 0
  const percent = Math.round(safeScore * 100)
  const meetsThreshold = threshold === undefined ? null : safeScore >= threshold
  const label = `Confidence ${percent}%${
    threshold === undefined ? '' : `, threshold ${Math.round(clamp(threshold) * 100)}%`
  }`

  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="relative h-2 w-full min-w-16 overflow-hidden rounded-sm bg-bg-subtle"
      >
        <div
          className={cn(
            'h-full rounded-sm transition-[width] duration-base ease-out',
            meetsThreshold === false ? 'bg-warning-solid' : 'bg-brand',
          )}
          style={{ width: `${percent}%` }}
        />
        {threshold !== undefined && (
          <div
            aria-hidden="true"
            className="absolute inset-y-0 w-0.5 bg-text-primary"
            style={{ left: `${Math.round(clamp(threshold) * 100)}%` }}
          />
        )}
      </div>
      <span className="w-10 shrink-0 text-right text-body-sm text-text-primary">{percent}%</span>
      {meetsThreshold !== null && (
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 text-body-sm',
            meetsThreshold ? 'text-success-text' : 'text-warning-text',
          )}
        >
          {meetsThreshold ? (
            <CheckCircle2 aria-hidden="true" className="h-3 w-3" />
          ) : (
            <TriangleAlert aria-hidden="true" className="h-3 w-3" />
          )}
          {meetsThreshold ? 'Meets threshold' : 'Below threshold'}
        </span>
      )}
    </div>
  )
}
