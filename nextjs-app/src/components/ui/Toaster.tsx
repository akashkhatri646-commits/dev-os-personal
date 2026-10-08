'use client'

import * as ToastPrimitive from '@radix-ui/react-toast'
import { CheckCircle2, TriangleAlert, X } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { cn } from '@/lib/utils/cn'

type ToastTone = 'success' | 'danger' | 'info'

interface ToastItem {
  id: number
  title: string
  description?: string
  tone: ToastTone
}

interface ToastApi {
  toast: (toast: { title: string; description?: string; tone?: ToastTone }) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const TONE_CLASS: Record<ToastTone, string> = {
  success: 'border-success-border bg-success-bg',
  danger: 'border-danger-border bg-danger-bg',
  info: 'border-info-border bg-info-bg',
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])

  const toast = useCallback<ToastApi['toast']>(({ title, description, tone = 'info' }) => {
    setItems((current) => [...current, { id: Date.now() + Math.random(), title, description, tone }])
  }, [])

  const api = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={api}>
      <ToastPrimitive.Provider swipeDirection="right" duration={6000}>
        {children}
        {items.map((item) => (
          <ToastPrimitive.Root
            key={item.id}
            onOpenChange={(open) => {
              if (!open) setItems((current) => current.filter((entry) => entry.id !== item.id))
            }}
            className={cn('flex items-start gap-3 rounded-lg border p-4', TONE_CLASS[item.tone])}
          >
            {item.tone === 'danger' ? (
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-danger-text" />
            ) : (
              <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success-text" />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <ToastPrimitive.Title className="text-body-lg text-text-primary">
                {item.title}
              </ToastPrimitive.Title>
              {item.description && (
                <ToastPrimitive.Description className="text-body-sm text-text-secondary">
                  {item.description}
                </ToastPrimitive.Description>
              )}
            </div>
            <ToastPrimitive.Close aria-label="Dismiss notification" className="rounded-sm text-text-secondary hover:text-text-primary">
              <X aria-hidden="true" className="h-4 w-4" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed bottom-4 right-4 z-50 flex w-[calc(100vw-32px)] max-w-sm flex-col gap-2 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used within ToastProvider')
  return context
}
