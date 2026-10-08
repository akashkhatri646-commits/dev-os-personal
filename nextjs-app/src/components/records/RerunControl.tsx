'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useToast } from '@/components/ui/Toaster'
import { rerunRecord } from '@/lib/api/ingestions'
import { queryKeys } from '@/lib/api/queryKeys'

const STAGES = [
  { value: 'normalize', label: 'Read the document' },
  { value: 'extract', label: 'Extract fields' },
  { value: 'map', label: 'Code the terms' },
  { value: 'validate', label: 'Validate' },
  { value: 'score', label: 'Score' },
  { value: 'route', label: 'Routing decision' },
] as const

/** Admin: send a failed or in-review record back to a chosen step, whatever stopped it. */
export function RerunControl({ recordId }: { recordId: string }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [stage, setStage] = useState<string>('extract')
  const [confirming, setConfirming] = useState(false)

  const rerun = useMutation({
    mutationFn: () => rerunRecord(recordId, stage),
    onSuccess: async () => {
      setConfirming(false)
      await queryClient.invalidateQueries({ queryKey: queryKeys.recordDetail(recordId) })
      toast({ title: 'Re-run queued', description: 'The record will be processed again from that step.', tone: 'success' })
    },
  })

  return (
    <>
      <select
        aria-label="Step to re-run from"
        value={stage}
        onChange={(event) => setStage(event.target.value)}
        className="rounded-md border border-border bg-bg-primary px-2 py-2 text-body-sm text-text-primary focus:border-border-brand"
      >
        {STAGES.map((entry) => (
          <option key={entry.value} value={entry.value}>
            {entry.label}
          </option>
        ))}
      </select>
      <button type="button" className="btn-secondary" onClick={() => setConfirming(true)} disabled={rerun.isPending}>
        {rerun.isPending ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <RotateCcw aria-hidden="true" className="h-4 w-4" />}
        Re-run from step
      </button>
      <ConfirmDialog
        open={confirming}
        title="Re-run this record?"
        description="Results from the chosen step onward are replaced, and any open review task is removed. The action is recorded in the audit log."
        confirmLabel="Re-run"
        onOpenChange={setConfirming}
        onConfirm={async () => {
          await rerun.mutateAsync()
        }}
      />
    </>
  )
}
