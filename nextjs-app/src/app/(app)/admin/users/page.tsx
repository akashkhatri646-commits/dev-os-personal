import type { Metadata } from 'next'
import { UsersView } from '@/components/admin/UsersView'

export const metadata: Metadata = { title: 'Users — Trust at the Edge' }

export default function UsersPage() {
  return <UsersView />
}
