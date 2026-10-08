'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Flag, KeyRound, Pencil } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { RoleGate } from '@/components/layout/RoleGate'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { ErrorState } from '@/components/shared/ErrorState'
import { PageHeader } from '@/components/shared/PageHeader'
import { ApiKeyDialog } from '@/components/sources/ApiKeyDialog'
import { EditSourceDialog } from '@/components/sources/EditSourceDialog'
import { SafetyTab } from '@/components/sources/SafetyTab'
import { EvalStatusBadge, SourceStatusBadge } from '@/components/sources/SourceBadges'
import { ThresholdsTab } from '@/components/sources/ThresholdsTab'
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton'
import { TabPanel, Tabs } from '@/components/ui/Tabs'
import { useToast } from '@/components/ui/Toaster'
import { ApiError } from '@/lib/api/errors'
import { queryKeys } from '@/lib/api/queryKeys'
import { fetchSource, flagSourcePoor, rotateSourceKey } from '@/lib/api/sources'
import type { SourceDetail } from '@/types/sources'

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'thresholds', label: 'Thresholds' },
  { id: 'safety', label: 'Safety' },
] as const
type TabId = (typeof TABS)[number]['id']

const TYPE_LABEL = { hospital: 'Hospital', lab: 'Lab', clinic: 'Clinic' } as const
const SIZE_LABEL = { small: 'Small', medium: 'Medium', large: 'Large' } as const
const DOC_LABEL = { discharge_summary: 'Discharge summaries', lab_report: 'Lab reports', other: 'Other' } as const

function isTabId(value: string | null): value is TabId {
  return TABS.some((tab) => tab.id === value)
}

function DataPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-body-lg text-text-primary">{label}</dt>
      <dd className="text-body-sm text-text-secondary">{value}</dd>
    </div>
  )
}

export function SourceDetailView({ sourceId }: { sourceId: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const requestedTab = searchParams.get('tab')
  const [tab, setTab] = useState<TabId>(isTabId(requestedTab) ? requestedTab : 'overview')

  const query = useQuery({
    queryKey: queryKeys.source(sourceId),
    queryFn: () => fetchSource(sourceId),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 1,
  })

  function selectTab(next: string) {
    if (!isTabId(next)) return
    setTab(next)
    router.replace(`/sources/${sourceId}?tab=${next}`, { scroll: false })
  }

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-full max-w-md" />
        <SkeletonText lines={4} />
      </div>
    )
  }

  if (query.error) {
    const notFound = query.error instanceof ApiError && query.error.status === 404
    return (
      <div className="flex flex-col gap-4">
        <Link href="/sources" className="text-body-sm text-brand hover:underline">
          Back to sources
        </Link>
        <ErrorState
          error={query.error}
          title={notFound ? 'Source not found' : undefined}
          onRetry={notFound ? undefined : () => void query.refetch()}
        />
      </div>
    )
  }

  const source = query.data
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href="/sources" className="w-fit text-body-sm text-brand hover:underline">
          Back to sources
        </Link>
        <PageHeader
          title={source.name}
          description={`${TYPE_LABEL[source.provider_type]} · ${SIZE_LABEL[source.size_class]} · ${source.queue_depth} in review queue`}
          actions={
            <>
              <SourceStatusBadge status={source.status} />
              <EvalStatusBadge status={source.eval_status} />
            </>
          }
        />
      </div>

      {source.status === 'paused' && (
        <p role="status" className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-body-sm text-warning-text">
          Auto-commit paused{source.pause_reason ? `: ${source.pause_reason}` : '.'}{' '}
          <RoleGate allow={['admin']}>
            <Link href="/incidents" className="underline">
              View incidents
            </Link>
          </RoleGate>
        </p>
      )}

      <Tabs tabs={TABS} active={tab} onChange={selectTab} ariaLabel="Source sections" />

      <TabPanel id="overview" active={tab}>
        <OverviewTab source={source} />
      </TabPanel>
      <TabPanel id="thresholds" active={tab}>
        <ThresholdsTab source={source} />
      </TabPanel>
      <TabPanel id="safety" active={tab}>
        <SafetyTab source={source} />
      </TabPanel>
    </div>
  )
}

function OverviewTab({ source }: { source: SourceDetail }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [editOpen, setEditOpen] = useState(false)
  const [rotateOpen, setRotateOpen] = useState(false)
  const [flagOpen, setFlagOpen] = useState(false)
  const [newKey, setNewKey] = useState<string | null>(null)

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.source(source.id) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.sources })
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4 rounded-lg border border-border bg-bg-primary p-6" aria-labelledby="source-details">
        <div className="flex items-center justify-between gap-2">
          <h2 id="source-details" className="text-h5 text-text-primary">
            Details
          </h2>
          <RoleGate allow={['integration_engineer', 'admin']}>
            <button type="button" className="btn-secondary" onClick={() => setEditOpen(true)}>
              <Pencil aria-hidden="true" className="h-4 w-4" />
              Edit
            </button>
          </RoleGate>
        </div>
        <dl className="grid gap-4 sm:grid-cols-2">
          <DataPair label="Provider type" value={TYPE_LABEL[source.provider_type]} />
          <DataPair label="Size" value={SIZE_LABEL[source.size_class]} />
          <DataPair label="Region" value={source.region ?? 'Not set'} />
          <DataPair label="Primary language" value={source.primary_language.toUpperCase()} />
          <DataPair label="Document types" value={source.doc_types.map((type) => DOC_LABEL[type]).join(', ')} />
          <DataPair label="Consent regime" value={source.consent_regime.toUpperCase()} />
          <DataPair label="Audit holdback" value={`${source.holdback_pct}%`} />
        </dl>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-border bg-bg-primary p-6" aria-labelledby="source-key">
        <h2 id="source-key" className="text-h5 text-text-primary">
          Ingestion API key
        </h2>
        <p className="text-body-sm text-text-secondary">
          Feed integrations authenticate with the <code className="font-mono">X-Source-Key</code> header. The full key
          is shown only when it is created or rotated.
        </p>
        <p className="font-mono text-body-lg text-text-primary">
          {source.key_prefix ? `hik_${source.key_prefix}_••••••••••••••••` : 'No active key'}
        </p>
        <RoleGate allow={['admin']}>
          <div>
            <button type="button" className="btn-secondary" onClick={() => setRotateOpen(true)}>
              <KeyRound aria-hidden="true" className="h-4 w-4" />
              Rotate key
            </button>
          </div>
        </RoleGate>
      </section>

      <RoleGate allow={['reviewer', 'admin']}>
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-bg-primary p-6" aria-labelledby="source-flag">
          <h2 id="source-flag" className="text-h5 text-text-primary">
            Report a quality problem
          </h2>
          <p className="text-body-sm text-text-secondary">
            Flag this source if its records are consistently poor. Admins see a warning; auto-commit is not changed.
          </p>
          <div>
            <button type="button" className="btn-secondary" onClick={() => setFlagOpen(true)} disabled={source.flagged_poor}>
              <Flag aria-hidden="true" className="h-4 w-4" />
              {source.flagged_poor ? 'Already flagged' : 'Flag as consistently poor'}
            </button>
          </div>
        </section>
      </RoleGate>

      <EditSourceDialog
        source={source}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={() => {
          refresh()
          toast({ title: 'Source updated', description: source.name, tone: 'success' })
        }}
      />

      <ConfirmDialog
        open={rotateOpen}
        onOpenChange={setRotateOpen}
        title="Rotate the API key?"
        description="The current key stops working immediately. Update the integration with the new key right after."
        confirmLabel="Rotate key"
        destructive
        onConfirm={async () => {
          const result = await rotateSourceKey(source.id)
          refresh()
          setNewKey(result.api_key)
        }}
      />
      <ApiKeyDialog apiKey={newKey} title="New API key" onClose={() => setNewKey(null)} />

      <ConfirmDialog
        open={flagOpen}
        onOpenChange={setFlagOpen}
        title="Flag this source?"
        description="Explain what is going wrong so admins can act on it."
        confirmLabel="Flag source"
        requireReason={{ min: 5, label: 'What is wrong?' }}
        onConfirm={async (note) => {
          if (!note) return
          await flagSourcePoor(source.id, note)
          refresh()
          toast({ title: 'Source flagged', description: source.name, tone: 'success' })
        }}
      />
    </div>
  )
}
