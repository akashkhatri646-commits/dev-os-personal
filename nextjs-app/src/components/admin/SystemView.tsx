'use client'

import { useMutation, useQuery } from '@tanstack/react-query'
import { CheckCircle2, Loader2, RefreshCw, TriangleAlert, XCircle } from 'lucide-react'
import { ErrorState } from '@/components/shared/ErrorState'
import { PageHeader } from '@/components/shared/PageHeader'
import { Skeleton } from '@/components/ui/Skeleton'
import { apiFetch } from '@/lib/api/client'
import { queryKeys } from '@/lib/api/queryKeys'
import type { ModelCheckResult } from '@/server/services/llm/healthCheck'
import type { CheckStatus, SelfCheckResult } from '@/server/services/system/selfCheck'

const STATUS_STYLE: Record<CheckStatus, { icon: typeof CheckCircle2; className: string; label: string }> = {
  ok: { icon: CheckCircle2, className: 'text-success-text', label: 'OK' },
  warn: { icon: TriangleAlert, className: 'text-warning-text', label: 'Needs attention' },
  fail: { icon: XCircle, className: 'text-danger-text', label: 'Broken' },
}

export function SystemView() {
  const check = useQuery({
    queryKey: queryKeys.systemCheck,
    queryFn: async () => (await apiFetch<SelfCheckResult>('/api/admin/system/check')).data,
    staleTime: 0,
    retry: false,
  })
  const model = useMutation({ mutationFn: async () => (await apiFetch<ModelCheckResult>('/api/admin/llm/check', { method: 'POST' })).data })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="System check"
        description="Finds missing settings, unapplied database migrations and a stopped worker before they break a record. Nothing here changes any data."
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={() => model.mutate()} disabled={model.isPending}>
              {model.isPending && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
              Test the model
            </button>
            <button type="button" className="btn-secondary" onClick={() => void check.refetch()} disabled={check.isFetching}>
              {check.isFetching ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="h-4 w-4" />}
              Run again
            </button>
          </>
        }
      />

      {model.data && (
        <section aria-label="Model test" className="rounded-lg border border-border bg-bg-primary p-4">
          <h2 className="mb-2 text-body-lg text-text-primary">Model test ({model.data.provider ?? 'not configured'})</h2>
          <ul className="flex flex-col gap-2">
            {model.data.checks.map((entry) => (
              <li key={entry.name} className="flex items-start gap-2 text-body-sm">
                {entry.ok ? <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 text-success-text" /> : <XCircle aria-hidden="true" className="mt-0.5 h-4 w-4 text-danger-text" />}
                <span className="text-text-primary">
                  {entry.name}
                  {entry.model ? ` (${entry.model})` : ''}
                  {entry.ok ? (entry.latency_ms !== null ? `: ${entry.latency_ms} ms` : '') : `: ${entry.problem ?? 'failed'}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {model.isError && <p role="alert" className="text-body-sm text-danger-text">The model test could not run.</p>}

      {check.isPending && (
        <div aria-busy="true" aria-label="Running the checks" className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
      {check.isError && <ErrorState error={check.error} onRetry={() => void check.refetch()} />}

      {check.data && (
        <>
          <p role="status" className={check.data.ok ? 'text-body-lg text-success-text' : 'text-body-lg text-danger-text'}>
            {check.data.ok ? 'Nothing is broken.' : 'Something is broken: fix the items marked Broken first.'}
          </p>
          {check.data.groups.map((group) => (
            <section key={group.title} aria-label={group.title} className="rounded-lg border border-border bg-bg-primary">
              <h2 className="border-b border-border px-4 py-3 text-body-lg text-text-primary">{group.title}</h2>
              <ul className="divide-y divide-border">
                {group.items.map((entry) => {
                  const style = STATUS_STYLE[entry.status]
                  const Icon = style.icon
                  return (
                    <li key={entry.id} className="flex items-start gap-3 px-4 py-3">
                      <Icon aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${style.className}`} />
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-body-lg text-text-primary">
                          {entry.label} <span className={`text-body-sm ${style.className}`}>{style.label}</span>
                        </span>
                        <span className="text-body-sm text-text-secondary">{entry.detail}</span>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  )
}
