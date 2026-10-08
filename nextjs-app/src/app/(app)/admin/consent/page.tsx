import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ConsentAdminView } from '@/components/consent/ConsentAdminView'
import { getEnv } from '@/server/config/env'

export const metadata: Metadata = { title: 'Consent ledger — Trust at the Edge' }

export default function ConsentAdminPage() {
  // The stub ledger is a test tool: with the real ledger selected this page does not exist.
  if (getEnv().CONSENT_MODE !== 'stub') notFound()
  return <ConsentAdminView />
}
