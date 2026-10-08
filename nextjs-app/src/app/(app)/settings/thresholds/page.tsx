import type { Metadata } from 'next'
import { ThresholdMatrixView } from '@/components/sources/ThresholdMatrixView'

export const metadata: Metadata = { title: 'Threshold matrix — Trust at the Edge' }

export default function ThresholdsPage() {
  return <ThresholdMatrixView />
}
