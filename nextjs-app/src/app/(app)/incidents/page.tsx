import type { Metadata } from 'next'
import { IncidentsView } from '@/components/incidents/IncidentsView'

export const metadata: Metadata = { title: 'Incidents — Trust at the Edge' }

export default function IncidentsPage() {
  return <IncidentsView />
}
