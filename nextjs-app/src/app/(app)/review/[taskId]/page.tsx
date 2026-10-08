import type { Metadata } from 'next'
import { ReviewWorkspaceView } from '@/components/review/ReviewWorkspaceView'

export const metadata: Metadata = { title: 'Review — Trust at the Edge' }

export default function ReviewWorkspacePage({ params }: { params: { taskId: string } }) {
  return <ReviewWorkspaceView taskId={params.taskId} />
}
