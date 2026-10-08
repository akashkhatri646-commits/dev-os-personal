import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthUser } from '@/types/domain'

type Result = { data?: unknown; count?: number | null; error?: { message: string } | null }
const queues: Record<string, Result[]> = {}
const calls: { table: string; method: string; args: unknown[] }[] = []
const rpcResults: Record<string, Result> = {}
const appendAudit = vi.fn()

function next(table: string): Result {
  return queues[table]?.shift() ?? { data: [], error: null }
}

function builder(table: string) {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'order', 'limit']) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
  }
  chain.then = (resolve: (value: Result) => unknown) => Promise.resolve(next(table)).then(resolve)
  return chain
}

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => builder(table),
    rpc: (name: string) => Promise.resolve(rpcResults[name] ?? { data: null, error: null }),
  }),
}))
vi.mock('@/server/config/env', () => ({ requireEnvValue: () => 'test-hmac-key-0123456789abcdef0123' }))
vi.mock('@/server/services/audit/auditLog', () => ({
  appendAudit: (...args: unknown[]) => appendAudit(...args),
}))

import { AppError } from '@/lib/api/errors'
import { csvCell, exportAudit, searchAudit, verifyChain } from '@/server/services/audit/auditQuery'

const actor: AuthUser = {
  userId: 'admin-1',
  email: 'admin@b.co',
  orgId: 'org-1',
  orgName: 'Org',
  fullName: 'Admin',
  role: 'admin',
}

function stored(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    created_at: `2026-10-0${id}T10:00:00+00:00`,
    actor_type: 'user',
    actor_id: 'admin-1',
    event: 'source.created',
    record_id: null,
    payload: { source_id: 's-1' },
    hash: `${id}`.padEnd(64, 'a'),
    prev_hash: null,
    ...overrides,
  }
}

async function catchError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    return error as AppError
  }
  throw new Error('expected rejection')
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(queues)) delete queues[key]
  for (const key of Object.keys(rpcResults)) delete rpcResults[key]
  calls.length = 0
})

describe('csvCell', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
  })

  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)")
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell('@cmd')).toBe("'@cmd")
  })

  it('serialises objects as JSON and blanks nulls', () => {
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(42)).toBe('42')
  })
})

describe('searchAudit', () => {
  it('returns rows newest first with hash status, actor names and a next cursor', async () => {
    queues.audit_log = [{ data: [stored(3), stored(2), stored(1)], error: null }]
    queues.profiles = [{ data: [{ id: 'admin-1', full_name: 'Ada Admin' }], error: null }]
    rpcResults.check_audit_rows = {
      data: [
        { id: 3, hash_ok: true },
        { id: 2, hash_ok: false },
      ],
      error: null,
    }

    const result = await searchAudit(actor, { limit: 2 })

    expect(result.rows.map((row) => row.id)).toEqual([3, 2])
    expect(result.rows[0]).toMatchObject({ actor_name: 'Ada Admin', hash_ok: true, hash_short: '3aaaaaaaaaaa' })
    expect(result.rows[1]?.hash_ok).toBe(false)
    expect(result.nextCursor).toBe(Buffer.from('2').toString('base64url'))
  })

  it('reports no next cursor on the last page and treats missing check rows as failed', async () => {
    queues.audit_log = [{ data: [stored(1)], error: null }]
    rpcResults.check_audit_rows = { data: [], error: null }
    const result = await searchAudit(actor, { limit: 5 })
    expect(result.nextCursor).toBeNull()
    expect(result.rows[0]?.hash_ok).toBe(false)
  })

  it('scopes every query to the organisation and applies the cursor', async () => {
    queues.audit_log = [{ data: [], error: null }]
    await searchAudit(actor, { limit: 10, cursor: Buffer.from('7').toString('base64url') })
    expect(calls.some((call) => call.method === 'eq' && call.args[0] === 'org_id' && call.args[1] === 'org-1')).toBe(true)
    expect(calls.some((call) => call.method === 'lt' && call.args[0] === 'id' && call.args[1] === 7)).toBe(true)
  })

  it('rejects a malformed cursor', async () => {
    const error = await catchError(searchAudit(actor, { limit: 10, cursor: 'not-a-number' }))
    expect(error.code).toBe('VALIDATION_FAILED')
  })

  it('returns nothing without querying the log when the patient identifier matches no patient', async () => {
    queues.patients = [{ data: [], error: null }]
    const result = await searchAudit(actor, { limit: 10, patient_identifier: { type: 'abha', value: '12345678901234' } })
    expect(result.rows).toEqual([])
    expect(calls.some((call) => call.table === 'audit_log')).toBe(false)
  })

  it('filters by the hashed identifier, never the plaintext', async () => {
    queues.patients = [{ data: [{ id: 'p-1' }], error: null }]
    queues.audit_log = [{ data: [], error: null }]
    await searchAudit(actor, { limit: 10, patient_identifier: { type: 'abha', value: '12-3456-7890-1234' } })
    const hashFilter = calls.find((call) => call.table === 'patients' && call.method === 'eq' && call.args[0] === 'abha_hash')
    expect(hashFilter?.args[1]).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(calls)).not.toContain('12345678901234')
    expect(JSON.stringify(calls)).not.toContain('12-3456-7890-1234')
    expect(calls.some((call) => call.method === 'in' && call.args[0] === 'ingestion_records.patient_id')).toBe(true)
  })
})

describe('verifyChain', () => {
  it('reports ok when no entry is broken', async () => {
    rpcResults.verify_audit_chain = { data: null, error: null }
    expect(await verifyChain(actor)).toEqual({ ok: true, first_broken_id: null })
  })

  it('reports the first broken entry', async () => {
    rpcResults.verify_audit_chain = { data: 42, error: null }
    expect(await verifyChain(actor)).toEqual({ ok: false, first_broken_id: 42 })
  })
})

describe('exportAudit', () => {
  it('refuses to export more than 50,000 entries', async () => {
    queues.audit_log = [{ count: 50_001, data: null, error: null }]
    const error = await catchError(exportAudit(actor, { format: 'csv' }))
    expect(error.reason).toBe('TOO_MANY_ROWS')
    expect(appendAudit).not.toHaveBeenCalled()
  })

  it('exports CSV and audits the filter names but never their values', async () => {
    queues.patients = [{ data: [{ id: 'p-1' }], error: null }]
    queues.audit_log = [
      { count: 2, data: null, error: null },
      { data: [stored(2), stored(1, { payload: { note: '=HYPERLINK("x")' } })], error: null },
    ]
    const file = await exportAudit(actor, {
      format: 'csv',
      patient_identifier: { type: 'abha', value: '12345678901234' },
      events: ['source.created'],
    })

    expect(file.rowCount).toBe(2)
    expect(file.contentType).toContain('text/csv')
    expect(file.body.split('\r\n')[0]).toBe('id,created_at,actor_type,actor_id,event,record_id,payload,hash,prev_hash')
    expect(file.body).not.toContain('12345678901234')
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'audit.exported',
        payload: { format: 'csv', row_count: 2, filters: ['patient_identifier', 'events'] },
      }),
    )
  })

  it('exports valid JSON when asked', async () => {
    queues.audit_log = [{ count: 1, data: null, error: null }, { data: [stored(1)], error: null }]
    const file = await exportAudit(actor, { format: 'json' })
    expect(file.filename.endsWith('.json')).toBe(true)
    expect(JSON.parse(file.body)).toHaveLength(1)
  })

  it('exports an empty file for a patient filter that matches nobody', async () => {
    queues.patients = [{ data: [], error: null }]
    const file = await exportAudit(actor, {
      format: 'json',
      patient_identifier: { type: 'mrn', value: 'MRN-1' },
    })
    expect(file.rowCount).toBe(0)
    expect(JSON.parse(file.body)).toEqual([])
  })
})
