import { apiFetch } from '@/lib/api/client'
import type { CreateConsentArtifactFormInput } from '@/lib/validation/consent'
import type { ConsentArtifactView } from '@/types/consent'

export async function fetchConsentPage(cursor: string | undefined, limit = 50) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  const { data, meta } = await apiFetch<ConsentArtifactView[]>(`/api/admin/consent-artifacts?${params.toString()}`)
  return { artifacts: data, nextCursor: meta?.next_cursor ?? null }
}

export async function createConsentArtifact(input: CreateConsentArtifactFormInput): Promise<ConsentArtifactView> {
  return (await apiFetch<ConsentArtifactView>('/api/admin/consent-artifacts', { method: 'POST', body: JSON.stringify(input) })).data
}

export async function setConsentStatus(id: string, status: 'granted' | 'revoked'): Promise<ConsentArtifactView> {
  return (
    await apiFetch<ConsentArtifactView>(`/api/admin/consent-artifacts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    })
  ).data
}
