import type { Metadata } from 'next'
import { IngestView } from '@/components/ingest/IngestView'

export const metadata: Metadata = { title: 'Ingest — Trust at the Edge' }

export default function IngestPage() {
  return <IngestView />
}
