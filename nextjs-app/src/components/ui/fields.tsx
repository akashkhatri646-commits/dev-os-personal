import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/utils/cn'

const CONTROL_CLASS =
  'w-full rounded-md border bg-bg-primary px-3 py-2 text-body-lg text-text-primary transition-colors duration-fast ease-out placeholder:text-text-disabled focus:border-border-brand disabled:cursor-not-allowed disabled:bg-bg-surface disabled:text-text-disabled'

interface FieldShellProps {
  label: string
  error?: string
  hint?: string
  controlId: string
  children: ReactNode
}

function FieldShell({ label, error, hint, controlId, children }: FieldShellProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={controlId} className="text-body-lg text-text-primary">
        {label}
      </label>
      {children}
      {hint && !error && (
        <span id={`${controlId}-hint`} className="text-body-sm text-text-secondary">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${controlId}-error`} role="alert" className="text-body-sm text-danger-text">
          {error}
        </span>
      )}
    </div>
  )
}

function describedBy(controlId: string, error?: string, hint?: string): string | undefined {
  if (error) return `${controlId}-error`
  if (hint) return `${controlId}-hint`
  return undefined
}

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  error?: string
  hint?: string
}

/** Labelled text input with inline error/hint wired through aria-describedby (spec 11 §6, forms). */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, error, hint, id, className, ...rest },
  ref,
) {
  const generatedId = useId()
  const controlId = id ?? generatedId
  return (
    <FieldShell label={label} error={error} hint={hint} controlId={controlId}>
      <input
        ref={ref}
        id={controlId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(controlId, error, hint)}
        className={cn(CONTROL_CLASS, error ? 'border-danger-solid' : 'border-border', className)}
        {...rest}
      />
    </FieldShell>
  )
})

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string
  error?: string
  hint?: string
  options: readonly { value: string; label: string }[]
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, error, hint, id, options, className, ...rest },
  ref,
) {
  const generatedId = useId()
  const controlId = id ?? generatedId
  return (
    <FieldShell label={label} error={error} hint={hint} controlId={controlId}>
      <select
        ref={ref}
        id={controlId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(controlId, error, hint)}
        className={cn(CONTROL_CLASS, error ? 'border-danger-solid' : 'border-border', className)}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  )
})
