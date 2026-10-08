import { RefreshCw, TriangleAlert } from 'lucide-react'
import { ApiError } from '@/lib/api/errors'
import { cn } from '@/lib/utils/cn'

interface ErrorStateProps {
  error?: unknown
  /** Overrides the headline derived from the error. */
  title?: string
  onRetry?: () => void
  className?: string
}

function describe(error: unknown): { title: string; message: string; requestId: string | null } {
  if (error instanceof ApiError) {
    if (error.code === 'FORBIDDEN') {
      return {
        title: "You don't have access to this page",
        message: 'Ask an administrator if you need a different role.',
        requestId: error.requestId,
      }
    }
    if (error.code === 'NETWORK') {
      return { title: 'Connection problem', message: error.message, requestId: null }
    }
    return { title: 'Something went wrong', message: error.message, requestId: error.requestId }
  }
  return {
    title: 'Something went wrong',
    message: 'An unexpected error occurred. Try again.',
    requestId: null,
  }
}

export function ErrorState({ error, title, onRetry, className }: ErrorStateProps) {
  const described = describe(error)
  const canRetry = onRetry && !(error instanceof ApiError && error.code === 'FORBIDDEN')

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border border-danger-border bg-danger-bg px-6 py-12 text-center',
        className,
      )}
    >
      <TriangleAlert aria-hidden="true" className="h-6 w-6 text-danger-text" />
      <div className="flex flex-col gap-0.5">
        <p className="text-body-lg text-text-primary">{title ?? described.title}</p>
        <p className="max-w-md text-body-sm text-text-secondary">{described.message}</p>
        {described.requestId && (
          <p className="text-body-sm text-text-secondary">Request ID: {described.requestId}</p>
        )}
      </div>
      {canRetry && (
        <button type="button" onClick={onRetry} className="btn-secondary">
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
          Retry
        </button>
      )}
    </div>
  )
}
