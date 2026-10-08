import { PDFDocument } from 'pdf-lib'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Result = { data?: unknown; error?: { code?: string; message: string } | null }

const { state, mocks } = vi.hoisted(() => ({
  state: {
    queues: {} as Record<string, { data?: unknown; error?: { code?: string; message: string } | null }[]>,
    ops: [] as { table: string; op: string; values?: unknown }[],
  },
  mocks: {
    uploadDocument: vi.fn(),
    removeDocument: vi.fn(),
    enqueueJob: vi.fn(),
    appendAudit: vi.fn(),
    appendAuditBestEffort: vi.fn(),
    triggerWorkerTick: vi.fn(),
    upsertPatient: vi.fn(),
  },
}))

function next(key: string): Result {
  return state.queues[key]?.shift() ?? { data: null, error: null }
}

function builder(table: string) {
  let op = 'select'
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'neq', 'in', 'order', 'limit', 'lt', 'gte', 'lte', 'or', 'contains']) {
    chain[method] = () => chain
  }
  chain.insert = (values: unknown) => {
    op = 'insert'
    state.ops.push({ table, op, values })
    return chain
  }
  chain.delete = () => {
    op = 'delete'
    state.ops.push({ table, op })
    return chain
  }
  chain.maybeSingle = () => Promise.resolve(next(`${table}.${op}`))
  chain.then = (resolve: (value: Result) => unknown) => Promise.resolve(next(`${table}.${op}`)).then(resolve)
  return chain
}

vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => ({ from: (table: string) => builder(table) }) }))
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: () => ({ from: (table: string) => builder(table) }) }))
vi.mock('@/server/config/constants', () => ({
  getRuntimeConfig: () => ({ enabledDocTypes: ['discharge_summary'], signedUrlTtlSeconds: 300 }),
}))
vi.mock('@/server/config/env', () => ({ getEnv: () => ({ OCR_MAX_PAGES: 1 }), requireEnvValue: () => 'unused' }))
vi.mock('@/server/services/storage/documentStorage', () => ({
  documentPath: (org: string, record: string, name: string) => `${org}/${record}/${name}`,
  uploadDocument: (...args: unknown[]) => mocks.uploadDocument(...args),
  removeDocument: (...args: unknown[]) => mocks.removeDocument(...args),
  createSignedDocumentUrl: vi.fn(),
}))
vi.mock('@/server/queue/jobs', () => ({ enqueueJob: (...args: unknown[]) => mocks.enqueueJob(...args) }))
vi.mock('@/server/services/audit/auditLog', () => ({
  appendAudit: (...args: unknown[]) => mocks.appendAudit(...args),
  appendAuditBestEffort: (...args: unknown[]) => mocks.appendAuditBestEffort(...args),
}))
vi.mock('@/server/worker/trigger', () => ({ triggerWorkerTick: () => mocks.triggerWorkerTick() }))
vi.mock('@/server/services/patients/patientService', () => ({
  upsertPatient: (...args: unknown[]) => mocks.upsertPatient(...args),
}))
vi.mock('@/server/pipeline/orchestrator', async () => {
  const { z } = await import('zod')
  return {
    loadRecord: vi.fn(),
    setStatus: vi.fn(),
    recordRowSchema: z.object({
      id: z.string(),
      source_id: z.string(),
      doc_type: z.string(),
      input_kind: z.string(),
      status: z.string(),
      status_reason: z.string().nullable(),
      created_at: z.string(),
    }),
  }
})

import { AppError } from '@/lib/api/errors'
import type { SubmitIngestionMeta } from '@/lib/validation/ingestion'
import { submitIngestion, type IngestionPrincipal } from '@/server/services/ingestion/ingestionService'
import type { ParsedSubmission } from '@/server/services/ingestion/parseSubmission'
import type { AuthUser } from '@/types/domain'

const SOURCE_ID = '3f2b8c1e-5c1a-4d6e-9c5e-2f7a1b0d9e12'
const user: AuthUser = {
  userId: 'user-1',
  email: 'ie@b.co',
  orgId: 'org-1',
  orgName: 'Org',
  fullName: 'IE',
  role: 'integration_engineer',
}
const principal: IngestionPrincipal = { kind: 'user', user }

const meta: SubmitIngestionMeta = {
  source_id: SOURCE_ID,
  patient_identifier: { type: 'abha', value: '12345678901234' },
  doc_type: 'discharge_summary',
  data_categories: ['DischargeSummary'],
}

const pdfBytes = async (pages = 1) => {
  const document = await PDFDocument.create()
  for (let index = 0; index < pages; index += 1) document.addPage()
  return Buffer.from(await document.save())
}

const fileSubmission = async (pages = 1): Promise<ParsedSubmission> => ({
  meta,
  content: { kind: 'file', bytes: await pdfBytes(pages), filename: '../scan 1.pdf' },
})

const textSubmission = (text: string): ParsedSubmission => ({ meta, content: { kind: 'text', text } })

const HL7 = 'MSH|^~\\&|LAB|CITY|EHR|CITY|202610071200||ORU^R01|MSG001|P|2.5.1\rPID|1||MRN1'

async function catchError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    return error as AppError
  }
  throw new Error('expected rejection')
}

function stubSource(docTypes: string[] = ['discharge_summary']) {
  state.queues['provider_sources.select'] = [{ data: { id: SOURCE_ID, doc_types: docTypes }, error: null }]
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(state.queues)) delete state.queues[key]
  state.ops.length = 0
  mocks.upsertPatient.mockResolvedValue('patient-1')
  mocks.uploadDocument.mockResolvedValue(undefined)
  mocks.removeDocument.mockResolvedValue(undefined)
  mocks.enqueueJob.mockResolvedValue(undefined)
  mocks.appendAudit.mockResolvedValue(undefined)
  stubSource()
})

describe('submitIngestion', () => {
  it('stores the original, creates the record and queues the consent check', async () => {
    const result = await submitIngestion(principal, await fileSubmission(), null)

    expect(result.duplicate).toBe(false)
    expect(result.status).toBe('received')
    expect(result.record_ids).toHaveLength(1)

    const [path, body, contentType] = mocks.uploadDocument.mock.calls[0] ?? []
    expect(path).toMatch(new RegExp(`^org-1/${result.record_id}/scan_1.pdf$`))
    expect(Buffer.isBuffer(body)).toBe(true)
    expect(contentType).toBe('application/pdf')

    const recordInsert = state.ops.find((op) => op.table === 'ingestion_records' && op.op === 'insert')
    expect(recordInsert?.values).toMatchObject({
      id: result.record_id,
      org_id: 'org-1',
      source_id: SOURCE_ID,
      patient_id: 'patient-1',
      input_kind: 'pdf',
      status: 'received',
      submitted_by: 'user-1',
    })
    expect((recordInsert?.values as { content_sha256: string }).content_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(mocks.appendAudit).toHaveBeenCalledWith(expect.objectContaining({ event: 'ingest.received' }))
    expect(mocks.enqueueJob).toHaveBeenCalledWith(result.record_id, 'consent_check')
    expect(mocks.triggerWorkerTick).toHaveBeenCalledTimes(1)
  })

  it('never puts the patient identifier into the audit payload', async () => {
    await submitIngestion(principal, await fileSubmission(), null)
    expect(JSON.stringify(mocks.appendAudit.mock.calls)).not.toContain('12345678901234')
  })

  it('returns the original record for a repeat submission without creating anything', async () => {
    state.queues['ingestion_records.select'] = [
      { data: { id: 'existing-1', status: 'needs_review', patient_id: 'patient-1' }, error: null },
    ]
    const result = await submitIngestion(principal, await fileSubmission(), null)

    expect(result).toMatchObject({ record_id: 'existing-1', duplicate: true, status: 'needs_review' })
    expect(mocks.uploadDocument).not.toHaveBeenCalled()
    expect(mocks.enqueueJob).not.toHaveBeenCalled()
    expect(mocks.triggerWorkerTick).not.toHaveBeenCalled()
    expect(mocks.appendAuditBestEffort).toHaveBeenCalledWith(expect.objectContaining({ event: 'ingest.duplicate' }))
  })

  it('refuses the same content for a different patient (consent-bypass guard)', async () => {
    state.queues['ingestion_records.select'] = [
      { data: { id: 'existing-1', status: 'committed', patient_id: 'someone-else' }, error: null },
    ]
    const error = await catchError(submitIngestion(principal, await fileSubmission(), null))
    expect(error.code).toBe('CONFLICT')
    expect(error.reason).toBe('CONTENT_PATIENT_MISMATCH')
    expect(mocks.uploadDocument).not.toHaveBeenCalled()
  })

  it('treats a unique-violation race as a duplicate of the winner', async () => {
    state.queues['ingestion_records.select'] = [
      { data: null, error: null },
      { data: { id: 'winner-1', status: 'received', patient_id: 'patient-1' }, error: null },
    ]
    state.queues['ingestion_records.insert'] = [{ error: { code: '23505', message: 'duplicate key' } }]
    const result = await submitIngestion(principal, await fileSubmission(), null)
    expect(result).toMatchObject({ record_id: 'winner-1', duplicate: true })
    expect(mocks.removeDocument).toHaveBeenCalledTimes(1)
  })

  it('rolls back the record and the stored file when queueing fails', async () => {
    mocks.enqueueJob.mockRejectedValue(new AppError('INTERNAL', 'queue down'))
    const error = await catchError(submitIngestion(principal, await fileSubmission(), null))
    expect(error.message).toBe('queue down')
    expect(state.ops.some((op) => op.table === 'ingestion_records' && op.op === 'delete')).toBe(true)
    expect(mocks.removeDocument).toHaveBeenCalledTimes(1)
    expect(mocks.triggerWorkerTick).not.toHaveBeenCalled()
  })

  it('rolls back when the document row cannot be saved', async () => {
    state.queues['documents.insert'] = [{ error: { message: 'insert failed' } }]
    await catchError(submitIngestion(principal, await fileSubmission(), null))
    expect(state.ops.some((op) => op.table === 'ingestion_records' && op.op === 'delete')).toBe(true)
    expect(mocks.removeDocument).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueJob).not.toHaveBeenCalled()
  })

  it('blocks a source key from submitting for another source before touching the database', async () => {
    const keyPrincipal: IngestionPrincipal = { kind: 'source_key', orgId: 'org-1', sourceId: 'other-source', keyId: 'k1' }
    const error = await catchError(submitIngestion(keyPrincipal, await fileSubmission(), null))
    expect(error.code).toBe('FORBIDDEN')
    expect(mocks.upsertPatient).not.toHaveBeenCalled()
  })

  it('audits source-key submissions as the api_key actor with no submitting user', async () => {
    const keyPrincipal: IngestionPrincipal = { kind: 'source_key', orgId: 'org-1', sourceId: SOURCE_ID, keyId: 'k1' }
    await submitIngestion(keyPrincipal, await fileSubmission(), null)
    expect(mocks.appendAudit).toHaveBeenCalledWith(expect.objectContaining({ actor: { type: 'api_key', id: 'k1' } }))
    const recordInsert = state.ops.find((op) => op.table === 'ingestion_records' && op.op === 'insert')
    expect((recordInsert?.values as { submitted_by: unknown }).submitted_by).toBeNull()
  })

  it('returns 404 for a source outside the organisation', async () => {
    state.queues['provider_sources.select'] = [{ data: null, error: null }]
    const error = await catchError(submitIngestion(principal, await fileSubmission(), null))
    expect(error.code).toBe('NOT_FOUND')
  })

  it('rejects a document type the source or the deployment has not enabled', async () => {
    stubSource(['lab_report'])
    const error = await catchError(submitIngestion(principal, await fileSubmission(), null))
    expect(error.reason).toBe('DOC_TYPE_NOT_ENABLED')
    expect(mocks.upsertPatient).not.toHaveBeenCalled()
  })

  it('rejects a PDF over the page limit before storing anything', async () => {
    const error = await catchError(submitIngestion(principal, await fileSubmission(2), null))
    expect(error.reason).toBe('TOO_MANY_PAGES')
    expect(mocks.uploadDocument).not.toHaveBeenCalled()
  })

  it('stores free text as a text record', async () => {
    await submitIngestion(principal, textSubmission('Patient seen for fever; discharged stable.'), null)
    const recordInsert = state.ops.find((op) => op.table === 'ingestion_records' && op.op === 'insert')
    expect(recordInsert?.values).toMatchObject({ input_kind: 'text' })
    expect(mocks.uploadDocument.mock.calls[0]?.[0]).toMatch(/input\.txt$/)
  })

  it('recognises HL7v2 and splits a batch into one record per message', async () => {
    const batch = `FHS|^~\\&\rBHS|^~\\&\r${HL7}\r${HL7.replace('MSG001', 'MSG002')}\rBTS|2\rFTS|1`
    const result = await submitIngestion(principal, textSubmission(batch), 'key-1')
    expect(result.record_ids).toHaveLength(2)
    const inserts = state.ops.filter((op) => op.table === 'ingestion_records' && op.op === 'insert')
    expect(inserts).toHaveLength(2)
    expect(inserts.map((op) => (op.values as { input_kind: string }).input_kind)).toEqual(['hl7v2', 'hl7v2'])
    // Each message gets its own idempotency key so the batch is safe to resubmit.
    expect(inserts.map((op) => (op.values as { idempotency_key: string }).idempotency_key)).toEqual(['key-1:0', 'key-1:1'])
    expect(mocks.triggerWorkerTick).toHaveBeenCalledTimes(1)
  })

  it('treats text that only starts with the letters MSH as an ordinary note', async () => {
    await submitIngestion(principal, textSubmission('MSH'), null)
    const recordInsert = state.ops.find((op) => op.table === 'ingestion_records' && op.op === 'insert')
    expect(recordInsert?.values).toMatchObject({ input_kind: 'text' })
  })
})
