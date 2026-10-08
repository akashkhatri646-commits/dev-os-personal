import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks, state } = vi.hoisted(() => ({
  mocks: {
    loadRecord: vi.fn(),
    setStatus: vi.fn(),
    runConsentCheck: vi.fn(),
    purge: vi.fn(),
    appendAudit: vi.fn(),
    sendAlert: vi.fn(),
    rpc: vi.fn(),
    update: vi.fn(),
    exists: vi.fn(),
  },
  state: {
    tables: {} as Record<string, { single?: unknown; list?: unknown[]; count?: number }>,
    updateResult: [{ id: 't1' }] as unknown[],
  },
}))

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      const entry = () => state.tables[table] ?? {}
      const query: Record<string, unknown> = {}
      for (const method of ['eq', 'gt', 'lt', 'in', 'or', 'limit', 'order', 'select']) query[method] = () => query
      query.maybeSingle = () => Promise.resolve({ data: entry().single ?? null, error: null })
      query.then = (resolve: (value: unknown) => unknown) => resolve({ data: entry().list ?? [], count: entry().count ?? 0, error: null })
      return {
        select: () => query,
        update: (values: unknown) => {
          mocks.update(table, values)
          const result: Record<string, unknown> = {}
          for (const method of ['eq', 'or']) result[method] = () => result
          result.select = () => Promise.resolve({ data: state.updateResult, error: null })
          result.then = (resolve: (value: unknown) => unknown) => resolve({ error: null })
          return result
        },
      }
    },
  }),
}))
vi.mock('@/server/config/env', () => ({ getEnv: () => ({ REVIEW_LOCK_MINUTES: 30, SIGNED_URL_TTL_SECONDS: 300, FHIR_VALIDATOR_MODE: 'node' }) }))
vi.mock('@/server/pipeline/orchestrator', () => ({ loadRecord: mocks.loadRecord, setStatus: mocks.setStatus }))
vi.mock('@/server/services/consent/runCheck', () => ({ runConsentCheck: mocks.runConsentCheck }))
vi.mock('@/server/services/review/purge', () => ({ purgeRecordPHI: mocks.purge }))
vi.mock('@/server/services/audit/auditLog', () => ({ appendAudit: mocks.appendAudit, appendAuditBestEffort: mocks.appendAudit }))
vi.mock('@/server/services/alerts/alerts', () => ({ sendAlert: mocks.sendAlert }))
vi.mock('@/server/services/storage/documentStorage', () => ({ createSignedDocumentUrl: async () => 'https://signed.example/doc' }))
vi.mock('@/server/services/terminology/search', () => ({
  SupabaseTerminologySearch: class {
    exists = mocks.exists
    search = async () => []
  },
  getEmbeddingsClient: () => null,
}))

import { claimTask, getWorkspace, heartbeatTask, releaseTask, requestReupload, submitReview } from '@/server/services/review/reviewService'
import type { RecordRow } from '@/server/pipeline/orchestrator'
import type { AuthUser } from '@/types/domain'

const reviewer: AuthUser = { userId: 'rev-1', email: 'r@example.org', orgId: 'org-1', orgName: null, fullName: null, role: 'reviewer' }
const admin: AuthUser = { ...reviewer, userId: 'adm-1', role: 'admin' }
const future = () => new Date(Date.now() + 10 * 60_000).toISOString()
const past = () => new Date(Date.now() - 60_000).toISOString()

const record = (overrides: Partial<RecordRow> = {}): RecordRow => ({
  id: 'rec-1',
  org_id: 'org-1',
  source_id: 's-1',
  patient_id: 'p-1',
  doc_type: 'discharge_summary',
  input_kind: 'pdf',
  data_categories: ['DischargeSummary'],
  status: 'in_review',
  status_reason: 'below_threshold',
  created_at: '2026-10-07T00:00:00Z',
  ...overrides,
})

const task = (overrides: Record<string, unknown> = {}) => ({
  id: 't1',
  record_id: 'rec-1',
  status: 'claimed',
  kind: 'escalation',
  priority: 120,
  claimed_by: 'rev-1',
  lock_expires_at: future(),
  created_at: '2026-10-07T00:00:00Z',
  ...overrides,
})

const span = { page: 1, block_ids: ['b1'], quote: 'Metformin 500 mg BD', char_start: 0, char_end: 19 }
const field = (field_key: string, value: string | number, basis = 'stated') => ({ field_key, found: true, value, source_span: span, basis, model_confidence: 0.95 })

function seedRecordData(overrides: { fields?: unknown[]; scores?: unknown[] } = {}) {
  const fields = overrides.fields ?? [
    field('encounter.admission_date', '2025-03-01'),
    field('encounter.discharge_date', '2025-03-05'),
    field('encounter.class', 'inpatient', 'inferred'),
    field('medication[0].name', 'Metformin'),
    field('medication[0].dose_value', 500),
    field('medication[0].dose_unit', 'mg'),
    field('medication[0].frequency', 'twice daily'),
    field('medication[0].phase', 'discharge', 'inferred'),
  ]
  const fieldScore = (resource: string, key: string, score: number, caps: string[]) => ({ scope: 'field', field_key: key, resource_id: resource, score, components: { caps_applied: caps } })
  state.tables = {
    review_tasks: { single: task(), count: 0 },
    provider_sources: { single: { id: 's-1', name: 'City Hospital' } },
    documents: { single: { storage_path: 'org/rec/doc.pdf', mime_type: 'application/pdf', ocr_confidence: 0.99, normalized_text: [{ page: 1, text: 'Metformin 500 mg BD' }] } },
    routing_decisions: { single: { aggregate_score: 0.9, escalation_reasons: ['below_threshold'], reasoning_trace: 'trace', thresholds_applied: { MedicationRequest: { threshold: 0.95, version: 1, score: 0.9, pass: false }, Encounter: { threshold: 0.95, version: 1, score: 1, pass: true }, _checksum: 'x' } } },
    mapped_resources: {
      list: [
        { id: 'enc-1', resource_type: 'Encounter', source_ref: 'encounter', codings: [], flags: [], validation_status: 'pass', validation_issues: [] },
        { id: 'med-1', resource_type: 'MedicationRequest', source_ref: 'medication[0]', codings: [], flags: ['uncoded'], validation_status: 'pass', validation_issues: [] },
      ],
    },
    extracted_fields: { list: fields },
    field_scores: {
      list: overrides.scores ?? [
        { scope: 'resource', field_key: null, resource_id: 'med-1', score: 0.9, components: {} },
        ...['name', 'dose_value', 'dose_unit', 'frequency'].map((attr) => fieldScore('med-1', `medication[0].${attr}`, 1, attr === 'name' ? ['uncoded'] : [])),
        fieldScore('med-1', 'medication[0].phase', 0.8, ['inferred']),
        ...['admission_date', 'discharge_date'].map((attr) => fieldScore('enc-1', `encounter.${attr}`, 1, [])),
        fieldScore('enc-1', 'encounter.class', 0.8, ['inferred']),
      ],
    },
    consent_checks: { single: { result: 'valid', checked_at: '2026-10-07T00:00:00Z' } },
    terminology_concepts: { single: { display: 'Metformin' } },
  }
}

const REQUIRED_DECISIONS = [
  { field_key: 'medication[0].name', action: 'accept' as const },
  { field_key: 'medication[0].phase', action: 'accept' as const },
  { field_key: 'encounter.class', action: 'accept' as const },
]

beforeEach(() => {
  vi.clearAllMocks()
  seedRecordData()
  state.updateResult = [{ id: 't1' }]
  mocks.loadRecord.mockResolvedValue(record())
  mocks.runConsentCheck.mockResolvedValue({ missingSource: false, verdict: { result: 'valid', matchedScope: [] } })
  mocks.rpc.mockResolvedValue({ data: ['enc-1', 'med-1'], error: null })
  mocks.exists.mockResolvedValue(true)
})

describe('claimTask', () => {
  const open = () => {
    state.tables.review_tasks = { single: task({ status: 'open', claimed_by: null, lock_expires_at: null }), count: 0 }
    mocks.loadRecord.mockResolvedValue(record({ status: 'needs_review' }))
  }

  it('claims an open task, sets a lock, moves the record into review and audits it', async () => {
    open()
    const result = await claimTask(reviewer, 't1')
    expect(Date.parse(result.lock_expires_at)).toBeGreaterThan(Date.now() + 29 * 60_000)
    expect(mocks.update).toHaveBeenCalledWith('review_tasks', expect.objectContaining({ status: 'claimed', claimed_by: 'rev-1' }))
    expect(mocks.setStatus).toHaveBeenCalledWith(expect.anything(), 'in_review')
    expect(mocks.appendAudit.mock.calls[0]?.[0]).toMatchObject({ event: 'review.claimed', actor: { id: 'rev-1' } })
  })

  it('refuses a task another reviewer holds', async () => {
    state.tables.review_tasks = { single: task({ claimed_by: 'someone-else' }), count: 0 }
    await expect(claimTask(reviewer, 't1')).rejects.toMatchObject({ code: 'CONFLICT', reason: 'ALREADY_CLAIMED' })
  })

  it('lets a reviewer re-open their own live task without a new claim', async () => {
    const result = await claimTask(reviewer, 't1')
    expect(result.lock_expires_at).toBeTruthy()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('takes over a task whose lock expired', async () => {
    state.tables.review_tasks = { single: task({ claimed_by: 'someone-else', lock_expires_at: past() }), count: 0 }
    await expect(claimTask(reviewer, 't1')).resolves.toBeTruthy()
  })

  it('gives the second of two simultaneous claims a conflict', async () => {
    open()
    state.updateResult = []
    await expect(claimTask(reviewer, 't1')).rejects.toMatchObject({ reason: 'ALREADY_CLAIMED' })
  })

  it('stops at three open claims', async () => {
    open()
    state.tables.review_tasks = { single: task({ status: 'open', claimed_by: null, lock_expires_at: null }), count: 3 }
    await expect(claimTask(reviewer, 't1')).rejects.toMatchObject({ reason: 'CLAIM_LIMIT' })
  })

  it('blocks the record, purges its data and closes the task when consent is gone', async () => {
    open()
    mocks.runConsentCheck.mockResolvedValue({ missingSource: false, verdict: { result: 'revoked', matchedScope: [] } })
    await expect(claimTask(reviewer, 't1')).rejects.toMatchObject({ reason: 'CONSENT_NO_LONGER_VALID' })
    expect(mocks.setStatus).toHaveBeenCalledWith(expect.anything(), 'blocked_consent', { reason: 'revoked' })
    expect(mocks.purge).toHaveBeenCalledWith('org-1', 'rec-1')
    expect(mocks.update).toHaveBeenCalledWith('review_tasks', expect.objectContaining({ status: 'completed' }))
  })

  it('reports a ledger outage as retryable without blocking anything', async () => {
    open()
    mocks.runConsentCheck.mockResolvedValue({ missingSource: false, verdict: { result: 'error', matchedScope: [] } })
    await expect(claimTask(reviewer, 't1')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' })
    expect(mocks.purge).not.toHaveBeenCalled()
  })

  it('answers 410 for a task whose record is already finished', async () => {
    mocks.loadRecord.mockResolvedValue(record({ status: 'committed' }))
    await expect(claimTask(reviewer, 't1')).rejects.toMatchObject({ code: 'GONE', reason: 'TASK_CLOSED' })
  })

  it('does not show another organisation a task', async () => {
    mocks.loadRecord.mockResolvedValue(record({ org_id: 'org-2' }))
    await expect(claimTask(reviewer, 't1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('heartbeat and release', () => {
  it('extends a live hold and refuses an expired one', async () => {
    await expect(heartbeatTask(reviewer, 't1')).resolves.toBeTruthy()
    state.tables.review_tasks = { single: task({ lock_expires_at: past() }) }
    await expect(heartbeatTask(reviewer, 't1')).rejects.toMatchObject({ reason: 'LOCK_LOST' })
  })

  it('lets the holder or an admin release, but not another reviewer', async () => {
    await expect(releaseTask(reviewer, 't1')).resolves.toBeUndefined()
    expect(mocks.setStatus).toHaveBeenCalledWith(expect.anything(), 'needs_review')
    state.tables.review_tasks = { single: task({ claimed_by: 'someone-else' }) }
    await expect(releaseTask(reviewer, 't1')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(releaseTask(admin, 't1')).resolves.toBeUndefined()
  })
})

describe('getWorkspace', () => {
  it('returns the fields, scores and trace for the holder, and audits the document access', async () => {
    const workspace = await getWorkspace(reviewer, 't1')
    expect(workspace.document.signed_url).toBe('https://signed.example/doc')
    expect(workspace.document.pages).toHaveLength(1)
    expect(workspace.resources.map((resource) => resource.resource_type)).toEqual(['Encounter', 'MedicationRequest'])
    expect(workspace.decision?.thresholds_applied).not.toHaveProperty('_checksum')
    expect(mocks.appendAudit.mock.calls[0]?.[0]).toMatchObject({ event: 'document.accessed' })
  })

  it('requires a reviewer to claim first and refuses another reviewer', async () => {
    state.tables.review_tasks = { single: task({ status: 'open', claimed_by: null, lock_expires_at: null }) }
    await expect(getWorkspace(reviewer, 't1')).rejects.toMatchObject({ code: 'FORBIDDEN', reason: 'CLAIM_REQUIRED' })
    state.tables.review_tasks = { single: task({ claimed_by: 'someone-else' }) }
    await expect(getWorkspace(reviewer, 't1')).rejects.toMatchObject({ code: 'FORBIDDEN', reason: 'CLAIMED_BY_OTHER' })
    await expect(getWorkspace(admin, 't1')).resolves.toBeTruthy()
  })

  it('shows an audit sample to a reviewer as an ordinary escalation', async () => {
    state.tables.review_tasks = { single: task({ kind: 'holdback_audit' }) }
    ;(state.tables.routing_decisions as { single: { escalation_reasons: string[] } }).single.escalation_reasons = ['holdback']
    const workspace = await getWorkspace(reviewer, 't1')
    expect(workspace.task.kind).toBe('escalation')
    expect(workspace.decision?.reasons).toEqual([])
    expect((await getWorkspace(admin, 't1')).task.kind).toBe('holdback_audit')
  })
})

describe('submitReview', () => {
  it('commits through submit_review with one correction per field and only the change differing', async () => {
    const result = await submitReview(reviewer, 't1', {
      overall: 'approve',
      decisions: [...REQUIRED_DECISIONS.slice(1), { field_key: 'medication[0].name', action: 'correct', code: { system: 'snomed', code: '372567009' } }, { field_key: 'medication[0].dose_value', action: 'correct', value: 250 }],
    })
    expect(result).toEqual({ status: 'committed', fhir_resource_ids: ['enc-1', 'med-1'] })
    const [name, args] = mocks.rpc.mock.calls[0] as [string, Record<string, any>]
    expect(name).toBe('submit_review')
    expect(args.p_reviewer).toBe('rev-1')
    expect(args.p_corrections.filter((row: { action: string }) => row.action !== 'accept').map((row: { field_key: string }) => row.field_key).sort()).toEqual(['medication[0].dose_value', 'medication[0].name'])
    expect(args.p_corrections).toHaveLength(8)
    expect(args.p_counts).toEqual({ accepted: 6, corrected: 2, rejected: 0 })
    expect(args.p_resources.map((resource: { id: string }) => resource.id)).toEqual(['enc-1', 'med-1'])
  })

  it('lists the fields still needing a decision and commits nothing', async () => {
    await expect(submitReview(reviewer, 't1', { overall: 'approve', decisions: [] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', reason: 'DECISION_MISSING' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a code that is not in the terminology', async () => {
    state.tables.terminology_concepts = { single: null as never }
    await expect(
      submitReview(reviewer, 't1', { overall: 'approve', decisions: [...REQUIRED_DECISIONS.slice(1), { field_key: 'medication[0].name', action: 'correct', code: { system: 'snomed', code: '000' } }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', reason: 'INVALID_CODE' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('returns the FHIR issues and commits nothing when a correction makes a resource invalid', async () => {
    state.tables.extracted_fields = { list: (state.tables.extracted_fields?.list ?? []).filter((row) => (row as { field_key: string }).field_key !== 'encounter.class') }
    state.tables.field_scores = { list: (state.tables.field_scores?.list ?? []).filter((row) => (row as { field_key: string | null }).field_key !== 'encounter.class') }
    const error = await submitReview(reviewer, 't1', { overall: 'approve', decisions: [...REQUIRED_DECISIONS.slice(0, 2), { field_key: 'encounter.class', action: 'accept' }] }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('refuses when the hold has expired', async () => {
    state.tables.review_tasks = { single: task({ lock_expires_at: past() }) }
    await expect(submitReview(reviewer, 't1', { overall: 'approve', decisions: REQUIRED_DECISIONS })).rejects.toMatchObject({ reason: 'LOCK_LOST' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('re-checks consent before committing', async () => {
    mocks.runConsentCheck.mockResolvedValue({ missingSource: false, verdict: { result: 'expired', matchedScope: [] } })
    await expect(submitReview(reviewer, 't1', { overall: 'approve', decisions: REQUIRED_DECISIONS })).rejects.toMatchObject({ reason: 'CONSENT_NO_LONGER_VALID' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('maps a database lock failure to LOCK_LOST', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'lock_lost' } })
    await expect(submitReview(reviewer, 't1', { overall: 'approve', decisions: REQUIRED_DECISIONS })).rejects.toMatchObject({ reason: 'LOCK_LOST' })
  })

  it('rejects the record with every field stored as rejected', async () => {
    const result = await submitReview(reviewer, 't1', { overall: 'reject_record', decisions: [], note: 'wrong patient' })
    expect(result).toEqual({ status: 'rejected' })
    const [name, args] = mocks.rpc.mock.calls[0] as [string, Record<string, any>]
    expect(name).toBe('reject_review')
    expect(args.p_corrections.every((row: { action: string }) => row.action === 'reject')).toBe(true)
  })
})

describe('requestReupload', () => {
  it('closes the record only for scan, file or language problems', async () => {
    mocks.loadRecord.mockResolvedValue(record({ status_reason: 'low_ocr_quality' }))
    await requestReupload(reviewer, 't1', { note: 'please rescan' })
    expect(mocks.setStatus).toHaveBeenCalledWith(expect.anything(), 'rejected', { reason: 'reupload_requested' })
    expect(mocks.appendAudit.mock.calls[0]?.[0].payload).toEqual({ task_id: 't1', note_length: 13 })

    mocks.loadRecord.mockResolvedValue(record({ status_reason: 'below_threshold' }))
    await expect(requestReupload(reviewer, 't1', { note: 'x' })).rejects.toMatchObject({ reason: 'NOT_REUPLOADABLE' })
  })
})
