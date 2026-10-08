import type { Metadata } from 'next'
import { SystemView } from '@/components/admin/SystemView'

export const metadata: Metadata = { title: 'System check — Trust at the Edge' }

export default function SystemPage() {
  return <SystemView />
}
