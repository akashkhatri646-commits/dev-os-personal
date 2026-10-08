import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthUser } from '@/types/domain'

const { state, mocks } = vi.hoisted(() => ({
  state: {
    mode: 'stub' as 'stub' | 'abdm',
    queues: {} as Record<string, { data?: unknown; error?: { code?: string; message: string } | null }[]>,
  },
  mocks: { appendAudit: vi.fn(), upsertPatient: vi.fn(), inserted: vi.fn() },
}))

function next(key: string) {
  return state.queues[key]?.shift() ?? { data: null, error: null }
}

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      let op = 'select'
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'order', 'limit', 'or', 'single']) {
        chain[method] = () => chain
      }
      chain.insert = (values: unknown) => {
        op = 'insert'
        mocks.inserted(table, values)
        return chain
      }
      chain.update = () => {
        op = 'update'
        return chain
      }
      chain.maybeSingle = () => Promise.resolve(next(`${table}.${op}`))
      chain.single = () => Promise.resolve(next(`${table}.${op}`))
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(next(`${table}.${op}`)).then(resolve)
      return chain
    },
  }),
}))
vi.mock('@/server/config/env', () => ({
  getEnv: () => ({ CONSENT_MODE: state.mode }),
  requireEnvValue: () => 'unused',
}))
vi.mock('@/server/services/audit/auditLog', () => ({ appendAudit: (...args: unknown[]) => mocks.appendAudit(...args) }))
vi.mock('@/server/services/patients/patientService', () => ({
  upsertPatient: (...args: unknown[]) => mocks.upsertPatient(...args),
}))
vi.mock('@/server/services/patients/patientIdentifiers', () => ({
  decryptIdentifier: (buffer: Buffer) => buffer.toString('utf8'),
  fromBytea: (value: string) => Buffer.from(value.replace('\\x', ''), 'hex'),
}))

import { AppError } from '@/lib/api/errors'
import {
  assertStubMode,
  createConsentArtifact,
  listConsentArtifacts,
  updateConsentArtifact,
} from '@/server/services/consent/artifactService'

const actor: AuthUser = {
  userId: 'admin-1',
  email: 'a@b.co',
  orgId: 'org-1',
  orgName: 'Org',
  fullName: 'Admin',
  role: 'admin',
}

const hex = (text: string) => `\\x${Buffer.from(text).toString('hex')}`
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'art-1',
  artifact_ref: 'consent-001',
  categories: ['DischargeSummary'],
  valid_from: '2000-01-01T00:00:00Z',
  valid_to: '2999-01-01T00:00:00Z',
  status: 'granted',
  created_at: '2026-10-01T00:00:00Z',
  patients: { org_id: 'org-1', abha_enc: hex('12345678901234'), mrn_enc: null },
  ...overrides,
})

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
  state.mode = 'stub'
  for (const key of Object.keys(state.queues)) delete state.queues[key]
  mocks.upsertPatient.mockResolvedValue('patient-1')
  mocks.appendAudit.mockResolvedValue(undefined)
})

describe('stub-only tools', () => {
  it('do not exist (404) once the real ledger is selected', async () => {
    state.mode = 'abdm'
    expect(() => assertStubMode()).toThrow(AppError)
    expect((await catchError(listConsentArtifacts(actor, { limit: 10 }))).code).toBe('NOT_FOUND')
    expect((await catchError(updateConsentArtifact(actor, 'art-1', { status: 'revoked' }))).code).toBe('NOT_FOUND')
    expect(mocks.upsertPatient).not.toHaveBeenCalled()
  })
})

describe('listConsentArtifacts', () => {
  it('masks the patient identifier and derives the effective status', async () => {
    state.queues['consent_artifacts.select'] = [
      {
        data: [
          row(),
          row({ id: 'art-2', status: 'revoked' }),
          row({ id: 'art-3', valid_to: '2001-01-01T00:00:00Z' }),
          row({ id: 'art-4', valid_from: '2998-01-01T00:00:00Z' }),
        ],
        error: null,
      },
    ]
    const { artifacts, nextCursor } = await listConsentArtifacts(actor, { limit: 10 })

    expect(nextCursor).toBeNull()
    expect(artifacts.map((artifact) => artifact.effective_status)).toEqual(['valid', 'revoked', 'expired', 'not_yet_valid'])
    expect(artifacts[0]?.patient_label).toBe('ABHA ••••1234')
    expect(JSON.stringify(artifacts)).not.toContain('12345678901234')
  })

  it('shows an MRN label and degrades safely when an identifier cannot be read', async () => {
    state.queues['consent_artifacts.select'] = [
      {
        data: [
          row({ patients: { org_id: 'org-1', abha_enc: null, mrn_enc: hex('MRN-2024-77') } }),
          row({ id: 'art-2', patients: { org_id: 'org-1', abha_enc: null, mrn_enc: null } }),
        ],
        error: null,
      },
    ]
    const { artifacts } = await listConsentArtifacts(actor, { limit: 10 })
    expect(artifacts[0]?.patient_label).toBe('MRN ••••4-77')
    expect(artifacts[1]?.patient_label).toBe('Unknown patient')
  })
})

describe('createConsentArtifact', () => {
  const input = {
    source_id: '3f2b8c1e-5c1a-4d6e-9c5e-2f7a1b0d9e12',
    patient_identifier: { type: 'abha' as const, value: '12345678901234' },
    artifact_ref: 'consent-001',
    categories: ['DischargeSummary' as const],
    valid_from: '2026-10-01T00:00:00.000Z',
    valid_to: '2026-11-01T00:00:00.000Z',
    status: 'granted' as const,
  }

  it('creates the patient link and the artifact, and audits ids only', async () => {
    state.queues['provider_sources.select'] = [{ data: { id: input.source_id }, error: null }]
    state.queues['consent_artifacts.insert'] = [{ data: { id: 'art-1' }, error: null }]
    state.queues['consent_artifacts.select'] = [{ data: row(), error: null }]

    const view = await createConsentArtifact(actor, input)

    expect(mocks.upsertPatient).toHaveBeenCalledWith('org-1', input.source_id, input.patient_identifier)
    expect(mocks.inserted).toHaveBeenCalledWith(
      'consent_artifacts',
      expect.objectContaining({ patient_id: 'patient-1', regime: 'abdm', status: 'granted' }),
    )
    expect(view.id).toBe('art-1')
    expect(mocks.appendAudit).toHaveBeenCalledWith(expect.objectContaining({ event: 'consent.artifact_created' }))
    expect(JSON.stringify(mocks.appendAudit.mock.calls)).not.toContain('12345678901234')
  })

  it('404s for a source outside the organisation', async () => {
    state.queues['provider_sources.select'] = [{ data: null, error: null }]
    expect((await catchError(createConsentArtifact(actor, input))).code).toBe('NOT_FOUND')
    expect(mocks.upsertPatient).not.toHaveBeenCalled()
  })

  it('maps a duplicate reference to ARTIFACT_REF_TAKEN', async () => {
    state.queues['provider_sources.select'] = [{ data: { id: input.source_id }, error: null }]
    state.queues['consent_artifacts.insert'] = [{ data: null, error: { code: '23505', message: 'dup' } }]
    const error = await catchError(createConsentArtifact(actor, input))
    expect(error.code).toBe('CONFLICT')
    expect(error.reason).toBe('ARTIFACT_REF_TAKEN')
  })
})

describe('updateConsentArtifact', () => {
  it('revokes an artifact and audits the change', async () => {
    state.queues['consent_artifacts.select'] = [
      { data: row(), error: null },
      { data: row({ status: 'revoked' }), error: null },
    ]
    const view = await updateConsentArtifact(actor, 'art-1', { status: 'revoked' })
    expect(view.effective_status).toBe('revoked')
    expect(mocks.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'consent.artifact_updated', payload: { artifact_id: 'art-1', from: 'granted', to: 'revoked' } }),
    )
  })

  it('404s for an artifact of another organisation', async () => {
    state.queues['consent_artifacts.select'] = [{ data: null, error: null }]
    expect((await catchError(updateConsentArtifact(actor, 'art-9', { status: 'revoked' }))).code).toBe('NOT_FOUND')
  })
})
