import type { Metadata } from 'next'
import { NewSourceForm } from '@/components/sources/NewSourceForm'

export const metadata: Metadata = { title: 'New source — Trust at the Edge' }

export default function NewSourcePage() {
  return <NewSourceForm />
}
