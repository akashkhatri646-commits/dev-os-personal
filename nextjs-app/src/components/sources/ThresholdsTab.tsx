'use client'

import { useQueryClient } from '@tanstack/react-query'
import { History, Pencil } from 'lucide-react'
import { useState } from 'react'
import { RoleGate } from '@/components/layout/RoleGate'
import { EditThresholdDialog } from '@/components/sources/EditThresholdDialog'
import { ThresholdHistoryDialog } from '@/components/sources/ThresholdHistoryDialog'
import { useToast } from '@/components/ui/Toaster'
import { queryKeys } from '@/lib/api/queryKeys'
import {
  HIGH_RISK_RESOURCE_TYPES,
  RESOURCE_KEY_LABEL,
  THRESHOLD_RESOURCE_KEYS,
  type ThresholdResourceKey,
} from '@/lib/sources/rules'
import type { SourceDetail } from '@/types/sources'

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

export function ThresholdsTab({ source }: { source: SourceDetail }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [editing, setEditing] = useState<ThresholdResourceKey | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  const activeRows = source.thresholds_detail.filter((row) => row.active)
  const defaultRow = activeRows.find((row) => row.resource_type === '*')

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-body-sm text-text-secondary">
          A record auto-commits only if every resource scores at or above its threshold. Resource types without
          their own value use the default. Medication and allergy thresholds cannot go below 0.95.
        </p>
        <button type="button" className="btn-secondary" onClick={() => setHistoryOpen(true)}>
          <History aria-hidden="true" className="h-4 w-4" />
          History
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-bg-primary">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">Routing thresholds by resource type</caption>
          <thead className="border-b border-border bg-bg-surface">
            <tr>
              {['Resource type', 'Threshold', 'Version', 'Last reason', ''].map((heading, index) => (
                <th key={index} scope="col" className="px-4 py-3 text-body-sm font-medium text-text-secondary">
                  {heading || <span className="sr-only">Actions</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {THRESHOLD_RESOURCE_KEYS.map((key) => {
              const row = activeRows.find((candidate) => candidate.resource_type === key)
              const inherited = !row
              const value = row?.threshold ?? defaultRow?.threshold ?? null
              const highRisk = (HIGH_RISK_RESOURCE_TYPES as readonly string[]).includes(key)
              return (
                <tr key={key} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-3 text-body-lg text-text-primary">
                    {RESOURCE_KEY_LABEL[key]}
                    {highRisk && <span className="badge-warning ml-2">High risk</span>}
                  </td>
                  <td className="px-4 py-3 text-body-lg tabular-nums text-text-primary">
                    {value === null ? '—' : value.toFixed(3)}
                    {inherited && <span className="badge-neutral ml-2">Inherited</span>}
                  </td>
                  <td className="px-4 py-3 text-body-sm tabular-nums text-text-secondary">
                    {row ? `v${row.version}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-body-sm text-text-secondary">
                    {row ? (
                      <>
                        {row.reason}
                        <span className="block">{dateFormatter.format(new Date(row.created_at))}</span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <RoleGate allow={['integration_engineer', 'admin']}>
                      <button
                        type="button"
                        onClick={() => setEditing(key)}
                        aria-label={`Edit threshold for ${RESOURCE_KEY_LABEL[key]}`}
                        className="btn-secondary px-3 py-1"
                      >
                        <Pencil aria-hidden="true" className="h-3 w-3" />
                        Edit
                      </button>
                    </RoleGate>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <EditThresholdDialog
        sourceId={source.id}
        resourceKey={editing}
        currentValue={editing ? (activeRows.find((row) => row.resource_type === editing)?.threshold ?? defaultRow?.threshold ?? null) : null}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
        onSaved={(key) => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.source(source.id) })
          void queryClient.invalidateQueries({ queryKey: queryKeys.sources })
          toast({ title: 'Threshold updated', description: RESOURCE_KEY_LABEL[key], tone: 'success' })
        }}
      />
      <ThresholdHistoryDialog sourceId={source.id} open={historyOpen} onOpenChange={setHistoryOpen} />
    </div>
  )
}
