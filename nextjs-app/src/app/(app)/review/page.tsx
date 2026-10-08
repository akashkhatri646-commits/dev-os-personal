import type { Metadata } from 'next'
import { ReviewQueueView } from '@/components/review/ReviewQueueView'

export const metadata: Metadata = { title: 'Review queue — Trust at the Edge' }

export default function ReviewQueuePage() {
  return <ReviewQueueView />
}
