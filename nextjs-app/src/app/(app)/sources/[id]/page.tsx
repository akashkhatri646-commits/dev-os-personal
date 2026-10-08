import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SourceDetailView } from '@/components/sources/SourceDetailView'
import { Skeleton } from '@/components/ui/Skeleton'

export const metadata: Metadata = { title: 'Source — Trust at the Edge' }

export default function SourceDetailPage({ params }: { params: { id: string } }) {
  return (
    <Suspense fallback={<Skeleton className="h-8 w-64" />}>
      <SourceDetailView sourceId={params.id} />
    </Suspense>
  )
}
