import { Ban, CheckCircle2, Circle, Loader2, MinusCircle, XCircle, type LucideIcon } from 'lucide-react'
import { buildPipelineSteps, formatDuration, type StepState } from '@/lib/records/pipeline'
import { cn } from '@/lib/utils/cn'
import type { RecordStatus } from '@/types/domain'
import type { RecordEvent } from '@/types/records'

const STATE: Record<StepState, { label: string; icon: LucideIcon; className: string; spin?: boolean }> = {
  done: { label: 'Done', icon: CheckCircle2, className: 'text-success-text' },
  current: { label: 'Running', icon: Loader2, className: 'text-info-text', spin: true },
  pending: { label: 'Waiting', icon: Circle, className: 'text-text-secondary' },
  failed: { label: 'Failed', icon: XCircle, className: 'text-danger-text' },
  blocked: { label: 'Blocked', icon: Ban, className: 'text-danger-text' },
  skipped: { label: 'Not run', icon: MinusCircle, className: 'text-text-disabled' },
}

const timeFormatter = new Intl.DateTimeFormat('en-GB', { timeStyle: 'medium', timeZone: 'UTC' })

/** The eight pipeline steps for a record, each with a state label as well as an icon and colour. */
export function PipelineTimeline({ status, events }: { status: RecordStatus; events: readonly RecordEvent[] }) {
  const steps = buildPipelineSteps(status, events)
  return (
    <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8" aria-label="Pipeline steps">
      {steps.map((step) => {
        const config = STATE[step.state]
        const Icon = config.icon
        const duration = formatDuration(step.durationMs)
        return (
          <li key={step.id} className="flex flex-col gap-1 rounded-md border border-border bg-bg-primary p-3">
            <span className={cn('inline-flex items-center gap-1 text-body-sm font-medium', config.className)}>
              <Icon aria-hidden="true" className={cn('h-4 w-4', config.spin && 'animate-spin')} />
              {config.label}
            </span>
            <span className="text-body-lg text-text-primary">{step.label}</span>
            {step.at && (
              <span className="text-body-sm text-text-secondary">
                {timeFormatter.format(new Date(step.at))} UTC{duration ? ` · ${duration}` : ''}
              </span>
            )}
            {step.note && <span className="text-body-sm text-text-secondary">{step.note}</span>}
          </li>
        )
      })}
    </ol>
  )
}
