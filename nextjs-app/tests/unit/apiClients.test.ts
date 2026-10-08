// The browser-side API layer: the fetch wrapper's error handling, and that every client function calls
// the route its server counterpart serves, with the right method and body.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.stubGlobal('fetch', fetchMock)

import { apiFetch, onUnauthenticated } from '@/lib/api/client'
import { ApiError } from '@/lib/api/errors'
import * as audit from '@/lib/api/audit'
import * as consent from '@/lib/api/consent'
import * as ingestions from '@/lib/api/ingestions'
import * as review from '@/lib/api/review'
import * as safety from '@/lib/api/safety'
import * as sources from '@/lib/api/sources'

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit | undefined]
  return { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined }
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => json(200, { data: [], meta: { next_cursor: 'next' } }))
  onUnauthenticated(null)
})

describe('apiFetch', () => {
  it('unwraps the envelope and keeps the pagination cursor', async () => {
    fetchMock.mockResolvedValue(json(200, { data: { a: 1 }, meta: { next_cursor: 'c2' } }))
    expect(await apiFetch('/api/x')).toEqual({ data: { a: 1 }, meta: { next_cursor: 'c2' } })
  })

  it('sets a JSON content type when it sends a body, but leaves form data alone', async () => {
    await apiFetch('/api/x', { method: 'POST', body: JSON.stringify({ a: 1 }) })
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get('content-type')).toBe('application/json')
    await apiFetch('/api/x', { method: 'POST', body: new FormData() })
    expect(new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).has('content-type')).toBe(false)
  })

  it('turns an error envelope into an ApiError with its code, status, request id and details', async () => {
    fetchMock.mockResolvedValue(json(409, { error: { code: 'CONFLICT', message: 'Nope', request_id: 'req-1', details: { reason: 'LOCK_LOST' } } }))
    await expect(apiFetch('/api/x')).rejects.toMatchObject({ code: 'CONFLICT', status: 409, requestId: 'req-1', details: { reason: 'LOCK_LOST' } })
  })

  it('reports an unexpected response, and a network failure, without leaking details', async () => {
    fetchMock.mockResolvedValue(new Response('<html>oops</html>', { status: 502, headers: { 'x-request-id': 'req-2' } }))
    await expect(apiFetch('/api/x')).rejects.toMatchObject({ code: 'INTERNAL', status: 502, requestId: 'req-2' })
    fetchMock.mockRejectedValue(new TypeError('failed to fetch'))
    await expect(apiFetch('/api/x')).rejects.toMatchObject({ code: 'NETWORK', status: 0 })
  })

  it('signs the user out on a 401 and answers a 204 with no data', async () => {
    const handler = vi.fn()
    onUnauthenticated(handler)
    fetchMock.mockResolvedValue(json(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in', request_id: 'r' } }))
    await expect(apiFetch('/api/x')).rejects.toBeInstanceOf(ApiError)
    expect(handler).toHaveBeenCalledTimes(1)
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    expect(await apiFetch('/api/x')).toEqual({ data: undefined })
  })
})

describe('client functions call the routes the server serves', () => {
  const cases: [string, () => Promise<unknown>, string, string][] = [
    ['sources list', () => sources.fetchSourcesPage('c1', 10), 'GET', '/api/sources?limit=10&cursor=c1'],
    ['source detail', () => sources.fetchSource('s1'), 'GET', '/api/sources/s1'],
    ['pause source', () => sources.pauseSource('s1', 'because'), 'POST', '/api/sources/s1/pause'],
    ['resume source', () => sources.resumeSource('s1', 'ok now'), 'POST', '/api/sources/s1/resume'],
    ['enable auto-commit', () => sources.enableAutoCommit('s1', 'ready'), 'POST', '/api/sources/s1/enable-auto-commit'],
    ['rotate key', () => sources.rotateSourceKey('s1'), 'POST', '/api/sources/s1/rotate-key'],
    ['flag poor', () => sources.flagSourcePoor('s1', 'poor scans'), 'POST', '/api/sources/s1/flag-poor'],
    ['threshold history', () => sources.fetchThresholdHistory('s1'), 'GET', '/api/sources/s1/thresholds/history'],
    ['consent list', () => consent.fetchConsentPage(undefined, 5), 'GET', '/api/admin/consent-artifacts?limit=5'],
    ['consent status', () => consent.setConsentStatus('a1', 'revoked'), 'PATCH', '/api/admin/consent-artifacts/a1'],
    ['audit search', () => audit.fetchAuditPage({ record_id: 'r1' }, 'c', 20), 'POST', '/api/audit/search'],
    ['audit verify', () => audit.verifyAuditChain(), 'GET', '/api/audit/verify'],
    ['records list', () => ingestions.fetchRecordsPage('c1', 25, { status: ['failed', 'rejected'], sourceId: 's1' }), 'GET', '/api/ingestions?limit=25&cursor=c1&status=failed%2Crejected&source_id=s1'],
    ['record detail', () => ingestions.fetchRecordDetail('r1'), 'GET', '/api/ingestions/r1'],
    ['record trace', () => ingestions.fetchRecordTrace('r1'), 'GET', '/api/ingestions/r1/trace'],
    ['reconstruction', () => ingestions.fetchReconstruction('r1'), 'GET', '/api/audit/records/r1'],
    ['document link', () => ingestions.fetchDocumentLink('r1'), 'GET', '/api/ingestions/r1/document'],
    ['retry', () => ingestions.retryRecord('r1'), 'POST', '/api/ingestions/r1/retry'],
    ['admin re-run', () => ingestions.rerunRecord('r1', 'map'), 'POST', '/api/admin/records/r1/rerun'],
    ['review queue', () => review.fetchReviewTasks({ status: 'open', mine: true, kind: 'escalation', resourceType: 'Condition' }, 'c1'), 'GET', '/api/review-tasks?status=open&limit=50&kind=escalation&mine=true&resource_type=Condition&cursor=c1'],
    ['claim', () => review.claimReviewTask('t1'), 'POST', '/api/review-tasks/t1/claim'],
    ['heartbeat', () => review.heartbeatReviewTask('t1'), 'POST', '/api/review-tasks/t1/heartbeat'],
    ['release', () => review.releaseReviewTask('t1'), 'POST', '/api/review-tasks/t1/release'],
    ['workspace', () => review.fetchReviewWorkspace('t1'), 'GET', '/api/review-tasks/t1'],
    ['submit review', () => review.submitReviewDecisions('t1', { decisions: [], overall: 'approve' }), 'POST', '/api/review-tasks/t1/submit'],
    ['request re-upload', () => review.requestReviewReupload('t1', 'rescan'), 'POST', '/api/review-tasks/t1/request-reupload'],
    ['terminology search', () => review.searchTerminology('metformin', 'snomed', 'MedicationRequest'), 'GET', '/api/terminology/search?q=metformin&system=snomed&resource_type=MedicationRequest'],
    ['incidents', () => safety.fetchIncidentsPage('open', 'c1'), 'GET', '/api/downstream-errors?limit=50&status=open&cursor=c1'],
    ['report error', () => safety.reportError('r1', { description: 'dose is wrong here', severity: 'high' }), 'POST', '/api/records/r1/error-report'],
    ['update incident', () => safety.updateIncident('i1', { status: 'investigating' }), 'PATCH', '/api/downstream-errors/i1'],
    ['pause all sources', () => safety.pauseAllSources('bad rollout'), 'POST', '/api/admin/sources/pause-all'],
  ]

  it.each(cases)('%s', async (_name, run, method, url) => {
    await run()
    expect(lastCall()).toMatchObject({ method, url })
  })

  it('sends the bodies the server schemas expect', async () => {
    await review.submitReviewDecisions('t1', { decisions: [{ field_key: 'a.b', action: 'accept' }], overall: 'approve' })
    expect(lastCall().body).toEqual({ decisions: [{ field_key: 'a.b', action: 'accept' }], overall: 'approve' })
    await review.requestReviewReupload('t1', 'rescan')
    expect(lastCall().body).toEqual({ note: 'rescan' })
    await safety.pauseAllSources('bad rollout')
    expect(lastCall().body).toEqual({ reason: 'bad rollout' })
    await audit.fetchAuditPage({ record_id: 'r1' }, 'c', 20)
    expect(lastCall().body).toEqual({ record_id: 'r1', limit: 20, cursor: 'c' })
  })

  it('returns the cursor with each page', async () => {
    fetchMock.mockResolvedValue(json(200, { data: [{ id: 'x' }], meta: { next_cursor: 'n2' } }))
    expect(await review.fetchReviewTasks({ status: 'open', mine: false }, undefined)).toEqual({ tasks: [{ id: 'x' }], nextCursor: 'n2' })
    fetchMock.mockResolvedValue(json(200, { data: [] }))
    expect((await safety.fetchIncidentsPage(undefined, undefined)).nextCursor).toBeNull()
  })
})
