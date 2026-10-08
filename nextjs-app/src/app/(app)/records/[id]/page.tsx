import type { Metadata } from 'next'
import { RecordDetailView } from '@/components/records/RecordDetailView'

export const metadata: Metadata = { title: 'Record — Trust at the Edge' }

export default function RecordDetailPage({ params }: { params: { id: string } }) {
  return <RecordDetailView recordId={params.id} />
}
