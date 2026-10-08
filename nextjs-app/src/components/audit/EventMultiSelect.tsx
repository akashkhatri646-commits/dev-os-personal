'use client'

import { AUDIT_EVENTS, type AuditEvent } from '@/types/audit'

interface EventMultiSelectProps {
  selected: readonly AuditEvent[]
  onChange: (next: AuditEvent[]) => void
}

/** Events grouped by their domain prefix (`auth`, `source`, ...), derived from the catalog. */
const GROUPS: { group: string; events: AuditEvent[] }[] = (() => {
  const map = new Map<string, AuditEvent[]>()
  for (const event of AUDIT_EVENTS) {
    const group = event.split('.')[0] ?? event
    map.set(group, [...(map.get(group) ?? []), event])
  }
  return [...map.entries()].map(([group, events]) => ({ group, events }))
})()

export function EventMultiSelect({ selected, onChange }: EventMultiSelectProps) {
  function toggle(event: AuditEvent) {
    onChange(selected.includes(event) ? selected.filter((item) => item !== event) : [...selected, event])
  }

  return (
    <details className="group relative">
      <summary className="flex cursor-pointer list-none items-center justify-between rounded-md border border-border bg-bg-primary px-3 py-2 text-body-lg text-text-primary hover:border-border-strong">
        <span>{selected.length === 0 ? 'All events' : `${selected.length} event type${selected.length === 1 ? '' : 's'}`}</span>
        <span aria-hidden="true" className="text-text-secondary">
          ▾
        </span>
      </summary>
      <div className="absolute z-20 mt-1 max-h-72 w-full min-w-64 overflow-y-auto rounded-lg border border-border bg-bg-primary p-3">
        {selected.length > 0 && (
          <button type="button" onClick={() => onChange([])} className="mb-2 text-body-sm text-brand hover:underline">
            Clear selection
          </button>
        )}
        {GROUPS.map(({ group, events }) => (
          <fieldset key={group} className="mb-3 last:mb-0">
            <legend className="mb-1 text-body-sm font-medium capitalize text-text-secondary">{group}</legend>
            <div className="flex flex-col gap-1">
              {events.map((event) => (
                <label key={event} className="flex items-center gap-2 text-body-sm text-text-primary">
                  <input
                    type="checkbox"
                    checked={selected.includes(event)}
                    onChange={() => toggle(event)}
                    className="h-4 w-4"
                  />
                  <span className="font-mono">{event}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
    </details>
  )
}
