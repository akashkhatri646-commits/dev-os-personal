import { apiFetch } from '@/lib/api/client'
import type {
  CreateSourceFormInput,
  UpdateSourceInput,
} from '@/lib/validation/sources'
import type { CreatedSource, SourceDetail, SourceSummary, ThresholdVersion } from '@/types/sources'

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })

export async function fetchSourcesPage(cursor: string | undefined, limit = 50) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  const { data, meta } = await apiFetch<SourceSummary[]>(`/api/sources?${params.toString()}`)
  return { sources: data, nextCursor: meta?.next_cursor ?? null }
}

export async function fetchSource(id: string): Promise<SourceDetail> {
  return (await apiFetch<SourceDetail>(`/api/sources/${id}`)).data
}

export async function createSource(input: CreateSourceFormInput): Promise<CreatedSource> {
  return (await apiFetch<CreatedSource>('/api/sources', json(input))).data
}

export async function patchSource(id: string, input: UpdateSourceInput): Promise<SourceDetail> {
  return (await apiFetch<SourceDetail>(`/api/sources/${id}`, { method: 'PATCH', body: JSON.stringify(input) })).data
}

export async function putThreshold(
  id: string,
  input: { resource_type: string; threshold: number; reason: string },
) {
  return (
    await apiFetch<{ version: number; previous: number | null }>(`/api/sources/${id}/thresholds`, {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  ).data
}

export async function fetchThresholdHistory(id: string): Promise<ThresholdVersion[]> {
  return (await apiFetch<ThresholdVersion[]>(`/api/sources/${id}/thresholds/history`)).data
}

export async function rotateSourceKey(id: string): Promise<{ api_key: string }> {
  return (await apiFetch<{ api_key: string }>(`/api/sources/${id}/rotate-key`, { method: 'POST' })).data
}

export async function enableAutoCommit(id: string, note: string): Promise<SourceDetail> {
  return (await apiFetch<SourceDetail>(`/api/sources/${id}/enable-auto-commit`, json({ note }))).data
}

export async function pauseSource(id: string, reason: string): Promise<SourceDetail> {
  return (await apiFetch<SourceDetail>(`/api/sources/${id}/pause`, json({ reason }))).data
}

export async function resumeSource(id: string, note: string): Promise<SourceDetail> {
  return (await apiFetch<SourceDetail>(`/api/sources/${id}/resume`, json({ note }))).data
}

export async function flagSourcePoor(id: string, note: string): Promise<void> {
  await apiFetch(`/api/sources/${id}/flag-poor`, json({ note }))
}
