import { CheckCircle2, CircleSlash, PauseCircle, XCircle, Hand } from 'lucide-react'
import type { EvalStatus, SourceStatus } from '@/types/sources'

const STATUS: Record<SourceStatus, { label: string; className: string; Icon: typeof Hand }> = {
  manual_only: { label: 'Manual only', className: 'badge-neutral', Icon: Hand },
  auto_commit: { label: 'Auto-commit on', className: 'badge-success', Icon: CheckCircle2 },
  paused: { label: 'Paused', className: 'badge-warning', Icon: PauseCircle },
}

export function SourceStatusBadge({ status }: { status: SourceStatus }) {
  const { label, className, Icon } = STATUS[status]
  return (
    <span className={className}>
      <Icon aria-hidden="true" className="h-3 w-3" />
      {label}
    </span>
  )
}

const EVAL: Record<EvalStatus, { label: string; className: string; Icon: typeof Hand }> = {
  none: { label: 'Not evaluated', className: 'badge-neutral', Icon: CircleSlash },
  passed: { label: 'Eval passed', className: 'badge-success', Icon: CheckCircle2 },
  failed: { label: 'Eval failed', className: 'badge-danger', Icon: XCircle },
}

export function EvalStatusBadge({ status }: { status: EvalStatus }) {
  const { label, className, Icon } = EVAL[status]
  return (
    <span className={className}>
      <Icon aria-hidden="true" className="h-3 w-3" />
      {label}
    </span>
  )
}
