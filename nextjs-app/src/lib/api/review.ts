import { apiFetch } from '@/lib/api/client'
import type { ReviewDecision } from '@/lib/validation/review'
import type { CodeSystem } from '@/types/domain'
import type { ReviewSubmitResult, ReviewTaskSummary, ReviewWorkspace, TerminologyHit } from '@/types/review'

export interface ReviewTaskFilters {
  status: 'open' | 'claimed'
  kind?: 'escalation' | 'holdback_audit'
  mine: boolean
  resourceType?: string
}

export async function fetchReviewTasks(filters: ReviewTaskFilters, cursor: string | undefined, limit = 50) {
  const params = new URLSearchParams({ status: filters.status, limit: String(limit) })
  if (filters.kind) params.set('kind', filters.kind)
  if (filters.mine) params.set('mine', 'true')
  if (filters.resourceType) params.set('resource_type', filters.resourceType)
  if (cursor) params.set('cursor', cursor)
  const { data, meta } = await apiFetch<ReviewTaskSummary[]>(`/api/review-tasks?${params.toString()}`)
  return { tasks: data, nextCursor: meta?.next_cursor ?? null }
}

export async function claimReviewTask(id: string): Promise<{ lock_expires_at: string }> {
  return (await apiFetch<{ lock_expires_at: string }>(`/api/review-tasks/${id}/claim`, { method: 'POST' })).data
}

export async function heartbeatReviewTask(id: string): Promise<{ lock_expires_at: string }> {
  return (await apiFetch<{ lock_expires_at: string }>(`/api/review-tasks/${id}/heartbeat`, { method: 'POST' })).data
}

export async function releaseReviewTask(id: string): Promise<void> {
  await apiFetch<{ released: true }>(`/api/review-tasks/${id}/release`, { method: 'POST' })
}

export async function fetchReviewWorkspace(id: string): Promise<ReviewWorkspace> {
  return (await apiFetch<ReviewWorkspace>(`/api/review-tasks/${id}`)).data
}

export async function submitReviewDecisions(
  id: string,
  body: { decisions: ReviewDecision[]; overall: 'approve' | 'reject_record'; note?: string },
): Promise<ReviewSubmitResult> {
  return (await apiFetch<ReviewSubmitResult>(`/api/review-tasks/${id}/submit`, { method: 'POST', body: JSON.stringify(body) })).data
}

export async function requestReviewReupload(id: string, note: string): Promise<void> {
  await apiFetch<{ requested: true }>(`/api/review-tasks/${id}/request-reupload`, { method: 'POST', body: JSON.stringify({ note }) })
}

export async function searchTerminology(query: string, system: CodeSystem, resourceType: string): Promise<TerminologyHit[]> {
  const params = new URLSearchParams({ q: query, system, resource_type: resourceType })
  return (await apiFetch<TerminologyHit[]>(`/api/terminology/search?${params.toString()}`)).data
}
