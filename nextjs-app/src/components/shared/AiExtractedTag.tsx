import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

/** Marks a value that was extracted by the pipeline, not typed by a person. Shown on every committed value. */
export function AiExtractedTag({ className }: { className?: string }) {
  return (
    <span className={cn('badge-info', className)} title="Extracted by AI from the source document. Not clinically verified.">
      <Bot aria-hidden="true" className="h-3 w-3" />
      AI-extracted
    </span>
  )
}
