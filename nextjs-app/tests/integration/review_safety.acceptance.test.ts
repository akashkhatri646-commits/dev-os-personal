// Acceptance tests for review, safety, audit reconstruction and FHIR read (docs/specs/15 §4: 7, 8, 9).
// Same approach as the pipeline suite: the real services run against an in-memory database.
import { STAGE_HANDLERS } from '@/server/pipeline/stages'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { holder, spies } = vi.hoisted(() => ({
  holder: {
    db: null as unknown as import('../support/fakeDb').FakeDb,
    files: new Map<string, Buffer>(),
    llm: null as unknown,
    consent: null as unknown,
    env: {} as Record<string, unknown>,
  },
  spies: { download: vi.fn(), llm: vi.fn(), alert: vi.fn(), consent: vi.fn() },
}))

vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => holder.db.client() }))
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: () => holder.db.client() }))
vi.mock('@/server/config/env', async () => {
  const { BASE_ENV } = await import('../support/baseEnv')
  return { getEnv: () => ({ ...BASE_ENV, ...holder.env }) }
})
vi.mock('@/server/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/server/services/alerts/alerts', () => ({ sendAlert: spies.alert }))
vi.mock('@/server/services/llm/LLMClient', () => ({ getLlmClient: () => holder.llm }))
vi.mock('@/server/services/storage/documentStorage', () => ({
  downloadDocument: async (path: string) => {
    spies.download(path)
    return holder.files.get(path)
  },
  createSignedDocumentUrl: async () => 'https://signed.example/document',
  removeDocument: async () => undefined,
}))
vi.mock('@/server/services/consent/ConsentService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/consent/ConsentService')>()),
  getConsentService: () => ({ verify: async () => undefined }),
  verifyConsent: async () => holder.consent,
}))
vi.mock('@/server/services/terminology/search', async () => {
  const fixtures = await import('../support/fixtures')
  return {
    SupabaseTerminologySearch: class {
      async search(query: string, system: string) {
        return fixtures.searchTerminology(query, system)
      }
      async exists() {
        return true
      }
    },
    getEmbeddingsClient: () => null,
  }
})

import { reconstructRecord } from '@/server/services/audit/reconstruct'
import { getDashboard } from '@/server/services/metrics/dashboard'
import { readFhirProvenance, readFhirResource, readFhirWithProvenance } from '@/server/services/fhir/fhirRead'
import { getRecordTrace } from '@/server/services/records/traceService'
import { claimTask, getWorkspace, heartbeatTask, submitReview } from '@/server/services/review/reviewService'
import { bulkCreateReviews, pauseAllSources, reportDownstreamError, updateIncident } from '@/server/services/safety/incidentService'
import { resumeSource } from '@/server/services/sources/sourceService'
import type { AuthUser } from '@/types/domain'
import type { ReviewDecision } from '@/lib/validation/review'
import { ORG, SOURCE, createHarness } from '../support/pipelineHarness'

const { reset, submit, drain, record, events, task } = createHarness(holder, spies)

const reviewer: AuthUser = { userId: 'rev-1', email: null, orgId: ORG, orgName: null, fullName: 'Rita Reviewer', role: 'reviewer' }
const otherReviewer: AuthUser = { ...reviewer, userId: 'rev-2', fullName: 'Ravi Reviewer' }
const admin: AuthUser = { ...reviewer, userId: 'adm-1', fullName: 'Asha Admin', role: 'admin' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  for (const user of [reviewer, otherReviewer, admin]) holder.db.seed('profiles', { id: user.userId, org_id: ORG, full_name: user.fullName, email: `${user.userId}@example.org`, role: user.role, active: true })
})

/** An escalated record waiting for review (its source has auto-commit off). */
async function escalated() {
  const id = await submit({ autoCommit: false })
  await drain()
  expect(record(id).status).toBe('needs_review')
  return id
}

/** Decisions that accept every field needing one, with optional changes. */
async function decisionsFor(taskId: string, overrides: Record<string, ReviewDecision> = {}): Promise<ReviewDecision[]> {
  const workspace = await getWorkspace(reviewer, taskId)
  const fields = workspace.resources.flatMap((resource) => resource.fields)
  const decisions = fields.filter((field) => field.needs_decision && !overrides[field.field_key]).map<ReviewDecision>((field) => ({ field_key: field.field_key, action: 'accept' }))
  return [...decisions, ...Object.values(overrides)]
}

describe('review', () => {
  it('lets a reviewer correct one field and approve: only that field differs, and the commit names the reviewer', async () => {
    const id = await escalated()
    const taskId = task(id)!.id
    await claimTask(reviewer, taskId)
    expect(record(id).status).toBe('in_review')

    const decisions = await decisionsFor(taskId, { 'medication[0].dose_value': { field_key: 'medication[0].dose_value', action: 'correct', value: 250, note: 'printed 250' } })
    const result = await submitReview(reviewer, taskId, { overall: 'approve', decisions })
    expect(result.status).toBe('committed')
    expect(record(id).status).toBe('committed')

    const corrections = holder.db.all('review_corrections', (row) => row.record_id === id)
    const fieldCount = holder.db.all('extracted_fields', (row) => row.record_id === id && row.found).length
    expect(corrections).toHaveLength(fieldCount)
    expect(corrections.filter((row) => row.action !== 'accept').map((row) => row.field_key)).toEqual(['medication[0].dose_value'])
    expect(corrections.find((row) => row.action === 'correct')).toMatchObject({ original_value: 500, corrected_value: 250 })

    const medication = holder.db.find('fhir_resources', (row) => row.record_id === id && row.resource_type === 'MedicationRequest')!
    expect(medication.resource.dosageInstruction[0].doseAndRate[0].doseQuantity.value).toBe(250)
    expect(holder.db.all('provenance', (row) => row.record_id === id).every((row) => row.reviewer_id === 'rev-1' && row.extraction_method === 'ai_extracted_human_reviewed')).toBe(true)
    expect(task(id)).toMatchObject({ status: 'completed' })
    expect(events(id)).toEqual(expect.arrayContaining(['review.claimed', 'review.submitted', 'record.committed']))
    expect(holder.db.all('audit_log', (row) => row.event === 'review.claimed')[0]).toMatchObject({ actor_id: 'rev-1' })
  })

  it('refuses a correction that would make the resource invalid, commits nothing, and keeps the task claimed', async () => {
    const id = await escalated()
    const taskId = task(id)!.id
    await claimTask(reviewer, taskId)
    const decisions = await decisionsFor(taskId, { 'encounter.discharge_date': { field_key: 'encounter.discharge_date', action: 'correct', value: '2999-01-01' } })
    await expect(submitReview(reviewer, taskId, { overall: 'approve', decisions })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(holder.db.rpcCalls.some((call) => call.name === 'submit_review')).toBe(false)
    expect(holder.db.all('fhir_resources')).toHaveLength(0)
    expect(task(id)).toMatchObject({ status: 'claimed', claimed_by: 'rev-1' })
    expect(record(id).status).toBe('in_review')
  })

  it('names the fields that still need a decision, and commits nothing', async () => {
    const id = await escalated()
    const taskId = task(id)!.id
    await claimTask(reviewer, taskId)
    await expect(submitReview(reviewer, taskId, { overall: 'approve', decisions: [] })).rejects.toMatchObject({ reason: 'DECISION_MISSING' })
    expect(holder.db.all('review_corrections')).toHaveLength(0)
  })

  it('gives the second claimer a conflict, and an expired hold lets another reviewer take over', async () => {
    const id = await escalated()
    const taskId = task(id)!.id
    await claimTask(reviewer, taskId)
    await expect(claimTask(otherReviewer, taskId)).rejects.toMatchObject({ reason: 'ALREADY_CLAIMED' })

    task(id)!.lock_expires_at = new Date(Date.now() - 60_000).toISOString()
    await expect(heartbeatTask(reviewer, taskId)).rejects.toMatchObject({ reason: 'LOCK_LOST' })
    await expect(submitReview(reviewer, taskId, { overall: 'approve', decisions: [] })).rejects.toMatchObject({ reason: 'LOCK_LOST' })
    await expect(claimTask(otherReviewer, taskId)).resolves.toBeTruthy()
    expect(task(id)).toMatchObject({ claimed_by: 'rev-2' })
  })

  it('stops a reviewer holding more than three tasks', async () => {
    const ids = [await escalated(), await escalated(), await escalated(), await escalated()]
    for (const id of ids.slice(0, 3)) await claimTask(reviewer, task(id)!.id)
    await expect(claimTask(reviewer, task(ids[3]!)!.id)).rejects.toMatchObject({ reason: 'CLAIM_LIMIT' })
  })

  it('blocks the record and purges its data when consent is revoked during review', async () => {
    const id = await escalated()
    const taskId = task(id)!.id
    await claimTask(reviewer, taskId)
    holder.consent = { result: 'revoked', matchedScope: [], detail: {} }
    const decisions = await decisionsFor(taskId).catch(() => [])
    await expect(submitReview(reviewer, taskId, { overall: 'approve', decisions })).rejects.toMatchObject({ reason: 'CONSENT_NO_LONGER_VALID' })

    expect(record(id).status).toBe('blocked_consent')
    expect(holder.db.all('extracted_fields', (row) => row.record_id === id)).toHaveLength(0)
    expect(holder.db.all('mapped_resources', (row) => row.record_id === id)).toHaveLength(0)
    expect(holder.db.find('documents', (row) => row.record_id === id)?.normalized_text).toBeNull()
    expect(task(id)).toMatchObject({ status: 'completed' })
    expect(events(id)).toEqual(expect.arrayContaining(['consent.blocked', 'record.phi_purged']))
    expect(holder.db.all('fhir_resources')).toHaveLength(0)
  })

  it('hides an audit sample from reviewers as an ordinary escalation', async () => {
    const id = await submit({ holdbackPct: 100 })
    await drain()
    const taskId = task(id)!.id
    await claimTask(reviewer, taskId)
    const asReviewer = await getWorkspace(reviewer, taskId)
    expect(asReviewer.task.kind).toBe('escalation')
    expect(asReviewer.decision?.reasons).not.toContain('holdback')
    const asAdmin = await getWorkspace(admin, taskId)
    expect(asAdmin.task.kind).toBe('holdback_audit')
    expect(asAdmin.decision?.reasons).toContain('holdback')
  })
})

describe('safety controls', () => {
  it('pauses the source on a high downstream error, escalates its next record, and resumes only after the incident is resolved', async () => {
    const first = await submit()
    await drain()
    expect(record(first).status).toBe('auto_committed')
    const resource = holder.db.find('fhir_resources', (row) => row.resource_type === 'MedicationRequest')!

    const incident = await reportDownstreamError(reviewer, first, { severity: 'high', description: 'The dose does not match the discharge summary', fhir_resource_id: resource.id })
    expect(incident).toMatchObject({ status: 'open', source_paused: true, source_name: 'City Hospital' })
    expect(holder.db.find('provider_sources', (row) => row.id === SOURCE)).toMatchObject({ auto_commit_enabled: false })
    expect(holder.db.find('fhir_resources', (row) => row.id === resource.id)?.resource).toMatchObject({ status: 'entered-in-error' })
    expect(holder.db.find('review_tasks', (row) => row.record_id === first && row.kind === 'downstream_error_review')).toMatchObject({ status: 'open', priority: 999 })
    expect(spies.alert).toHaveBeenCalled()

    const second = await submit()
    await drain()
    expect(record(second)).toMatchObject({ status: 'needs_review', status_reason: 'source_not_enabled' })

    await expect(resumeSource(admin, SOURCE, 'looks fine now')).rejects.toMatchObject({ reason: 'OPEN_INCIDENT' })
    await updateIncident(admin, incident.id, { status: 'resolved', root_cause: 'extraction', note: 'model misread the dose' })
    expect(holder.db.find('review_tasks', (row) => row.record_id === first && row.kind === 'downstream_error_review')).toMatchObject({ status: 'completed' })
    await resumeSource(admin, SOURCE, 'prompt fixed and re-evaluated').catch(() => undefined)
    expect(holder.db.find('provider_sources', (row) => row.id === SOURCE)).toMatchObject({ auto_commit_enabled: true, pause_reason: null })

    const third = await submit()
    await drain()
    expect(record(third).status).toBe('auto_committed')
  })

  it('pauses every source on request, and creates exactly one downstream review task per record', async () => {
    const ids = [await submit(), await submit()]
    await drain()
    expect(await bulkCreateReviews(admin, { record_ids: ids })).toEqual({ created: 2, already_open: 0 })
    expect(await bulkCreateReviews(admin, { record_ids: ids })).toEqual({ created: 0, already_open: 2 })
    expect(holder.db.all('review_tasks', (row) => row.kind === 'downstream_error_review')).toHaveLength(2)

    expect(await pauseAllSources(admin, { reason: 'bad rollout' })).toEqual({ paused: 1 })
    expect(holder.db.find('provider_sources', (row) => row.id === SOURCE)).toMatchObject({ auto_commit_enabled: false })
  })

  it('keeps a paused source from committing in-flight records (the commit stage re-checks)', async () => {
    const id = await submit()
    // A worker pass now carries a record through several stages, so pause the source from inside the routing
    // stage: after the decision is made and before the commit job runs.
    const routeStage = STAGE_HANDLERS.route
    STAGE_HANDLERS.route = async (context) => {
      const outcome = await routeStage!(context)
      Object.assign(holder.db.find('provider_sources', (row) => row.id === SOURCE)!, { auto_commit_enabled: false, pause_reason: 'paused during processing' })
      return outcome
    }
    try {
      await drain()
    } finally {
      STAGE_HANDLERS.route = routeStage
    }
    expect(record(id)).toMatchObject({ status: 'needs_review', status_reason: 'source_paused' })
    expect(holder.db.all('fhir_resources')).toHaveLength(0)
  })
})

describe('audit reconstruction and FHIR read', () => {
  it('reconstructs an auto-committed record completely: consent, scan, extraction, mapping, validation, scores, routing and commit', async () => {
    const id = await submit()
    await drain()
    const result = await reconstructRecord(admin, id)
    expect(result.record).toMatchObject({ status: 'auto_committed', source: { name: 'City Hospital' } })
    expect(result.consent).toMatchObject({ result: 'valid', required: ['DischargeSummary'] })
    expect(result.ocr).toMatchObject({ engine: 'text' })
    expect(result.extraction).toMatchObject({ fields_found: 9, model_id: 'test-model' })
    expect(result.mapping).toMatchObject({ resources: 3 })
    expect(result.validation).toHaveLength(3)
    expect(result.validation.every((entry) => entry.status === 'pass')).toBe(true)
    expect(result.scores.aggregate).toBeGreaterThanOrEqual(0.95)
    expect(result.scores.resources.every((entry) => entry.pass === true)).toBe(true)
    expect(result.routing).toMatchObject({ decision: 'auto_commit', reasons: [] })
    expect(result.commit).toMatchObject({ mode: 'auto' })
    expect(result.commit?.resource_ids).toHaveLength(3)
    expect(result.chain.map((row) => row.event)).toContain('record.committed')
    expect(result.chain.every((row) => row.hash_ok)).toBe(true)
  })

  it('reconstructs an escalated, reviewed record with the reviewer and the diff', async () => {
    const id = await escalated()
    const taskId = task(id)!.id
    await claimTask(reviewer, taskId)
    await submitReview(reviewer, taskId, { overall: 'approve', decisions: await decisionsFor(taskId, { 'medication[0].dose_value': { field_key: 'medication[0].dose_value', action: 'correct', value: 250 } }) })
    const result = await reconstructRecord(admin, id)
    expect(result.routing).toMatchObject({ decision: 'escalate', reasons: ['source_not_enabled'] })
    expect(result.review.tasks[0]).toMatchObject({ status: 'completed', claimed_by_name: 'Rita Reviewer' })
    expect(result.review.corrections.filter((entry) => entry.action === 'correct')).toMatchObject([{ field_key: 'medication[0].dose_value', original_value: 500, corrected_value: 250, reviewer_name: 'Rita Reviewer' }])
    expect(result.commit).toMatchObject({ mode: 'human' })
  })

  it('serves committed resources as FHIR with their provenance, and refuses another organisation', async () => {
    const id = await submit()
    await drain()
    const row = holder.db.find('fhir_resources', (resource) => resource.record_id === id && resource.resource_type === 'MedicationRequest')!
    const resource = (await readFhirResource(admin, 'MedicationRequest', row.id)) as Record<string, any>
    expect(JSON.stringify(resource.meta)).toContain('ai-extracted')
    const bundle = (await readFhirWithProvenance(admin, 'MedicationRequest', row.id)) as Record<string, any>
    expect(bundle.entry[1].resource).toMatchObject({ resourceType: 'Provenance', policy: expect.any(Array) })
    expect(JSON.stringify(bundle.entry[1].resource.extension)).toContain('ai_extracted_auto')
    expect(await readFhirProvenance(admin, row.id)).toMatchObject({ resourceType: 'Provenance' })
    await expect(readFhirResource({ ...admin, orgId: 'org-2' }, 'MedicationRequest', row.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(readFhirResource(admin, 'Condition', row.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('shows a committed record with its resources, drafts and provenance on the record page data', async () => {
    const id = await submit()
    await drain()
    const trace = await getRecordTrace(reviewer, id)
    expect(trace.fhir.every((entry) => entry.committed)).toBe(true)
    expect(trace.provenance).toHaveLength(3)
    expect(trace.provenance[0]).toMatchObject({ extraction_method: 'ai_extracted_auto', consent_artifact_ref: null })
    const fields = trace.resources.flatMap((resource) => resource.fields)
    expect(fields.length).toBeGreaterThan(0)
    expect(fields.every((field) => field.span?.quote)).toBe(true)
  })

  it('writes no patient data into any audit payload across the whole flow, including review and safety events', async () => {
    const id = await escalated()
    const taskId = task(id)!.id
    await claimTask(reviewer, taskId)
    await submitReview(reviewer, taskId, { overall: 'approve', decisions: await decisionsFor(taskId, { 'medication[0].dose_value': { field_key: 'medication[0].dose_value', action: 'correct', value: 250, note: 'printed 250' } }) })
    await reportDownstreamError(admin, id, { severity: 'medium', description: 'Dose looks wrong against the source document' })
    await reconstructRecord(admin, id)
    const payloads = JSON.stringify(holder.db.all('audit_log').map((row) => row.payload))
    for (const phi of ['Metformin', 'diabetes', 'printed 250', 'Dose looks wrong', 'general medicine']) expect(payloads).not.toContain(phi)
  })
})

describe('dashboard', () => {
  it('reports per-source numbers from real pipeline activity, with the counts behind each rate', async () => {
    // Two auto-committed, one audit sample reviewed and changed, one escalation reviewed and left as it was.
    await submit()
    await submit()
    await drain()
    const sample = await submit({ holdbackPct: 100 })
    await drain()
    Object.assign(holder.db.find('provider_sources', (row) => row.id === SOURCE)!, { holdback_pct: 0 })
    const sampleTask = task(sample)!.id
    await claimTask(reviewer, sampleTask)
    await submitReview(reviewer, sampleTask, { overall: 'approve', decisions: await decisionsFor(sampleTask, { 'medication[0].dose_value': { field_key: 'medication[0].dose_value', action: 'correct', value: 250 } }) })
    const open = await submit({ autoCommit: false })
    await drain()
    expect(record(open).status).toBe('needs_review')

    const data = await getDashboard(admin, 30)
    expect(data.sources).toHaveLength(1)
    expect(data.sources[0]).toMatchObject({
      source_name: 'City Hospital',
      records: 4,
      stp_count: 2,
      stp_rate: 0.5,
      holdback_samples: 1,
      holdback_changed: 1,
      holdback_error_rate: 1,
      queue_depth: 1,
      blocked_consent: 0,
      downstream_errors: 0,
    })
    expect(data.sources[0]!.cost_usd).toBeGreaterThan(0)
    expect(data.sources[0]!.mean_review_seconds).not.toBeNull()
    expect(data.totals).toMatchObject({ records: 4, stp_count: 2, queue_depth: 1, sources_with_gold_accuracy: 0 })
  })

  it('counts downstream errors and open incidents, and is readable by a viewer (aggregates only)', async () => {
    const id = await submit()
    await drain()
    await reportDownstreamError(admin, id, { severity: 'high', description: 'The dose does not match the source' })
    const viewer: AuthUser = { ...reviewer, userId: 'view-1', role: 'viewer' }
    const data = await getDashboard(viewer, 7)
    expect(data.sources[0]).toMatchObject({ downstream_errors: 1, open_incidents: 1, paused: true })
    expect(data.totals).toMatchObject({ downstream_errors: 1, open_incidents: 1 })
    const text = JSON.stringify(data)
    for (const phi of ['Metformin', 'diabetes', 'dose does not match']) expect(text).not.toContain(phi)
  })

  it("keeps another organisation's activity out", async () => {
    await submit()
    await drain()
    const data = await getDashboard({ ...admin, orgId: 'org-2' }, 30)
    expect(data.sources).toEqual([])
    expect(data.totals.records).toBe(0)
  })
})
