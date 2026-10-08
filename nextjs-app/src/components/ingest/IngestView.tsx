'use client'

import { RecentSubmissions } from '@/components/ingest/RecentSubmissions'
import { SubmitForm } from '@/components/ingest/SubmitForm'
import { PageHeader } from '@/components/shared/PageHeader'

export function IngestView() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Ingest records"
        description="Submit scans, faxes, HL7v2 messages or notes. Each record is consent-checked before anything is read, then processed in the background."
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <SubmitForm />
        <RecentSubmissions />
      </div>
    </div>
  )
}
