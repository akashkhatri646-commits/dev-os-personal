'use client'

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

export interface TabDefinition {
  id: string
  label: string
}

interface TabsProps {
  tabs: readonly TabDefinition[]
  active: string
  onChange: (id: string) => void
  ariaLabel: string
}

/** Accessible tab list (arrow keys, Home/End). Render panels with `TabPanel`. */
export function Tabs({ tabs, active, onChange, ariaLabel }: TabsProps) {
  const baseId = useId()
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})

  function handleKeyDown(event: KeyboardEvent, index: number) {
    const last = tabs.length - 1
    let next = index
    if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1
    else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    else return
    event.preventDefault()
    const target = tabs[next]
    if (!target) return
    onChange(target.id)
    refs.current[target.id]?.focus()
  }

  return (
    <div role="tablist" aria-label={ariaLabel} className="flex gap-1 border-b border-border">
      {tabs.map((tab, index) => {
        const selected = tab.id === active
        return (
          <button
            key={tab.id}
            ref={(element) => {
              refs.current[tab.id] = element
            }}
            id={`${baseId}-${tab.id}-tab`}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={`${baseId}-${tab.id}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              '-mb-px border-b-2 px-4 py-2 text-body-lg transition-colors duration-fast ease-out',
              selected
                ? 'border-brand text-brand'
                : 'border-transparent text-text-secondary hover:text-text-primary',
            )}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}

interface TabPanelProps {
  id: string
  active: string
  children: ReactNode
}

export function TabPanel({ id, active, children }: TabPanelProps) {
  if (id !== active) return null
  return (
    <div role="tabpanel" tabIndex={0} aria-label={id} className="outline-none">
      {children}
    </div>
  )
}
