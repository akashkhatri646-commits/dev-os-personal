'use client'

import { Check, Copy } from 'lucide-react'
import { useId, useRef, useState } from 'react'

interface CopyFieldProps {
  label: string
  value: string
}

/** Read-only value with a copy button; falls back to selecting the text when the clipboard API is blocked. */
export function CopyField({ label, value }: CopyFieldProps) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      inputRef.current?.select()
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-body-lg text-text-primary">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          ref={inputRef}
          id={inputId}
          readOnly
          value={value}
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 rounded-md border border-border bg-bg-surface px-3 py-2 font-mono text-body-sm text-text-primary"
        />
        <button type="button" onClick={copy} className="btn-secondary shrink-0">
          {copied ? (
            <Check aria-hidden="true" className="h-4 w-4" />
          ) : (
            <Copy aria-hidden="true" className="h-4 w-4" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <span role="status" className="sr-only">
        {copied ? `${label} copied to clipboard` : ''}
      </span>
    </div>
  )
}
