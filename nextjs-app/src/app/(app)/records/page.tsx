import type { Metadata } from 'next'
import { RecordsView } from '@/components/records/RecordsView'

export const metadata: Metadata = { title: 'Records — Trust at the Edge' }

export default function RecordsPage() {
  return <RecordsView />
}
