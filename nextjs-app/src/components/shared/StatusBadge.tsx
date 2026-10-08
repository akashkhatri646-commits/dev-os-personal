import {
  Ban,
  CheckCircle2,
  Clock,
  Eye,
  Loader2,
  TriangleAlert,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { RecordStatus } from '@/types/domain'

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

interface StatusConfig {
  label: string
  tone: Tone
  icon: LucideIcon
  spin?: boolean
}

// Status is always conveyed by label + icon, never by color alone (spec 11 §6).
const STATUS_CONFIG: Record<RecordStatus, StatusConfig> = {
  received: { label: 'Received', tone: 'neutral', icon: Clock },
  consent_check: { label: 'Processing (consent)', tone: 'info', icon: Loader2, spin: true },
  blocked_consent: { label: 'Blocked (consent)', tone: 'danger', icon: Ban },
  normalizing: { label: 'Processing (OCR)', tone: 'info', icon: Loader2, spin: true },
  extracting: { label: 'Processing (extraction)', tone: 'info', icon: Loader2, spin: true },
  mapping: { label: 'Processing (mapping)', tone: 'info', icon: Loader2, spin: true },
  validating: { label: 'Processing (validation)', tone: 'info', icon: Loader2, spin: true },
  scoring: { label: 'Processing (scoring)', tone: 'info', icon: Loader2, spin: true },
  routing: { label: 'Processing (routing)', tone: 'info', icon: Loader2, spin: true },
  needs_review: { label: 'Needs review', tone: 'warning', icon: TriangleAlert },
  in_review: { label: 'In review', tone: 'warning', icon: Eye },
  auto_committed: { label: 'Auto-committed', tone: 'success', icon: CheckCircle2 },
  committed: { label: 'Committed', tone: 'success', icon: CheckCircle2 },
  rejected: { label: 'Rejected', tone: 'danger', icon: XCircle },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
}

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'badge-neutral',
  info: 'badge-info',
  success: 'badge-success',
  warning: 'badge-warning',
  danger: 'badge-danger',
}

interface StatusBadgeProps {
  status: RecordStatus
  /** Extra context shown in the tooltip, e.g. the status reason code. */
  reason?: string | null
  className?: string
}

export function StatusBadge({ status, reason, className }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status]
  const Icon = config.icon
  return (
    <span
      className={cn(TONE_CLASS[config.tone], className)}
      title={reason ? `${config.label}: ${reason.replaceAll('_', ' ')}` : config.label}
    >
      <Icon aria-hidden="true" className={cn('h-3 w-3', config.spin && 'animate-spin')} />
      {config.label}
    </span>
  )
}
