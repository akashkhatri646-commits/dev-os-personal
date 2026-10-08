'use client'

import { useEffect, useRef, useState } from 'react'
import { createSupabaseBrowserClient } from '@/lib/supabase/browser'

const THROTTLE_MS = 500

/**
 * Subscribes to changes of the organisation's ingestion records over Supabase Realtime (row level
 * security limits what arrives). `onChange` is throttled. Returns whether the channel is live so
 * callers can fall back to polling while it is not (spec 11 §5).
 */
export function useRealtimeRecords(orgId: string, onChange: () => void): { connected: boolean } {
  const [connected, setConnected] = useState(false)
  const handler = useRef(onChange)
  handler.current = onChange

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let supabase: ReturnType<typeof createSupabaseBrowserClient>
    try {
      supabase = createSupabaseBrowserClient()
    } catch {
      setConnected(false)
      return
    }

    const channel = supabase
      .channel(`ingestion-records-${orgId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ingestion_records', filter: `org_id=eq.${orgId}` },
        () => {
          if (timer) return
          timer = setTimeout(() => {
            timer = null
            handler.current()
          }, THROTTLE_MS)
        },
      )
      .subscribe((status) => setConnected(status === 'SUBSCRIBED'))

    return () => {
      if (timer) clearTimeout(timer)
      void supabase.removeChannel(channel)
    }
  }, [orgId])

  return { connected }
}
