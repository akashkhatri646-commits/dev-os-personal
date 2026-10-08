import { apiFetch } from '@/lib/api/client'
import type { ErrorReportBody, UpdateIncidentBody } from '@/lib/validation/safety'
import type { Incident, IncidentStatus } from '@/types/safety'

export async function fetchIncidentsPage(status: IncidentStatus | undefined, cursor: string | undefined, limit = 50) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (status) params.set('status', status)
  if (cursor) params.set('cursor', cursor)
  const { data, meta } = await apiFetch<Incident[]>(`/api/downstream-errors?${params.toString()}`)
  return { incidents: data, nextCursor: meta?.next_cursor ?? null }
}

export async function reportError(recordId: string, body: ErrorReportBody): Promise<Incident> {
  return (await apiFetch<Incident>(`/api/records/${recordId}/error-report`, { method: 'POST', body: JSON.stringify(body) })).data
}

export async function updateIncident(id: string, body: UpdateIncidentBody): Promise<Incident> {
  return (await apiFetch<Incident>(`/api/downstream-errors/${id}`, { method: 'PATCH', body: JSON.stringify(body) })).data
}

export async function pauseAllSources(reason: string): Promise<{ paused: number }> {
  return (await apiFetch<{ paused: number }>('/api/admin/sources/pause-all', { method: 'POST', body: JSON.stringify({ reason }) })).data
}
