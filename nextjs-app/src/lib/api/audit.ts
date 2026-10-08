import { apiFetch } from '@/lib/api/client'
import { ApiError } from '@/lib/api/errors'
import type { AuditFilters } from '@/lib/validation/audit'
import type { ApiErrorBody } from '@/types/domain'
import type { AuditRow, AuditVerifyResult } from '@/types/auditApi'

export async function fetchAuditPage(filters: AuditFilters, cursor: string | undefined, limit = 50) {
  const { data, meta } = await apiFetch<AuditRow[]>('/api/audit/search', {
    method: 'POST',
    body: JSON.stringify({ ...filters, limit, ...(cursor ? { cursor } : {}) }),
  })
  return { rows: data, nextCursor: meta?.next_cursor ?? null }
}

export async function verifyAuditChain(): Promise<AuditVerifyResult> {
  return (await apiFetch<AuditVerifyResult>('/api/audit/verify')).data
}

/** Requests an export and triggers a browser download of the returned file. */
export async function downloadAuditExport(filters: AuditFilters, format: 'csv' | 'json'): Promise<number> {
  let response: Response
  try {
    response = await fetch('/api/audit/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...filters, format }),
      credentials: 'same-origin',
    })
  } catch {
    throw new ApiError('NETWORK', 'Unable to reach the server. Check your connection and retry.', 0, null)
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiErrorBody | null
    if (payload?.error) {
      throw new ApiError(payload.error.code, payload.error.message, response.status, payload.error.request_id)
    }
    throw new ApiError('INTERNAL', 'The export failed.', response.status, null)
  }

  const blob = await response.blob()
  const disposition = response.headers.get('content-disposition') ?? ''
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `audit-export.${format}`
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
  return Number(response.headers.get('x-row-count') ?? 0)
}
