'use client'

import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { EmptyState } from '@/components/shared/EmptyState'
import { locateQuote } from '@/lib/review/locate'
import { cn } from '@/lib/utils/cn'
import type { WorkspacePage, WorkspaceSpan } from '@/types/review'

interface SourceViewerProps {
  pages: readonly WorkspacePage[]
  originalUrl: string | null
  page: number
  onPageChange: (page: number) => void
  /** The citation of the selected field, highlighted on its page. */
  span: WorkspaceSpan | null
}

/**
 * The document as recognised text, page by page, with the selected field's cited quote highlighted.
 * (Page images arrive with the scan reader; the original file opens in a new tab.)
 */
export function SourceViewer({ pages, originalUrl, page, onPageChange, span }: SourceViewerProps) {
  const current = pages.find((entry) => entry.page === page) ?? pages[0]
  const markRef = useRef<HTMLElement | null>(null)
  const range = useMemo(() => (span && current && span.page === current.page ? locateQuote(current.text, span.quote) : null), [span, current])

  useEffect(() => {
    markRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [range, current?.page])

  if (!current) {
    return (
      <div className="flex flex-col gap-3">
        <EmptyState title="No document text" description="The recognised text is not available for this record." />
        {originalUrl && (
          <a className="btn-secondary w-fit" href={originalUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink aria-hidden="true" className="h-4 w-4" />
            Open the original file
          </a>
        )}
      </div>
    )
  }

  const index = pages.findIndex((entry) => entry.page === current.page)
  const previous = pages[index - 1]
  const next = pages[index + 1]

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button type="button" className="btn-secondary px-2 py-1" aria-label="Previous page" disabled={!previous} onClick={() => previous && onPageChange(previous.page)}>
            <ChevronLeft aria-hidden="true" className="h-4 w-4" />
          </button>
          <span className="text-body-sm text-text-primary" aria-live="polite">
            Page {current.page} of {pages.length}
          </span>
          <button type="button" className="btn-secondary px-2 py-1" aria-label="Next page" disabled={!next} onClick={() => next && onPageChange(next.page)}>
            <ChevronRight aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
        {originalUrl && (
          <a className="inline-flex items-center gap-1 text-body-sm text-text-secondary hover:text-text-primary" href={originalUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink aria-hidden="true" className="h-3 w-3" />
            Original file
          </a>
        )}
      </div>

      {span && span.page === current.page && !range && (
        <p className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-body-sm text-warning-text">
          The cited text could not be found on this page. Read it from the original file.
        </p>
      )}
      {span && span.page !== current.page && span.page > 0 && (
        <button type="button" className="w-fit text-body-sm text-text-secondary underline" onClick={() => onPageChange(span.page)}>
          This field is cited on page {span.page}
        </button>
      )}

      <article className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-bg-primary p-4" aria-label={`Text of page ${current.page}`}>
        <p className={cn('whitespace-pre-wrap break-words text-body-lg font-normal text-text-primary')}>
          {range ? (
            <>
              {current.text.slice(0, range[0])}
              <mark ref={markRef} className="rounded-sm bg-warning-bg px-0.5 text-text-primary outline outline-1 outline-warning-border">
                {current.text.slice(range[0], range[1])}
              </mark>
              {current.text.slice(range[1])}
            </>
          ) : (
            current.text
          )}
        </p>
      </article>
    </div>
  )
}
