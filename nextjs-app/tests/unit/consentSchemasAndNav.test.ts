import { describe, expect, it } from 'vitest'
import { navItemsForRole } from '@/components/layout/nav'
import { createConsentArtifactSchema, updateConsentArtifactSchema } from '@/lib/validation/consent'

const valid = {
  source_id: '3f2b8c1e-5c1a-4d6e-9c5e-2f7a1b0d9e12',
  patient_identifier: { type: 'abha', value: '12-3456-7890-1234' },
  artifact_ref: 'consent-001',
  categories: ['DischargeSummary'],
  valid_from: '2026-10-01T00:00:00Z',
  valid_to: '2026-11-01T00:00:00Z',
}

describe('createConsentArtifactSchema', () => {
  it('accepts a normal artifact and defaults the status to granted', () => {
    expect(createConsentArtifactSchema.parse(valid).status).toBe('granted')
  })

  it('requires the end to be after the start', () => {
    expect(createConsentArtifactSchema.safeParse({ ...valid, valid_to: valid.valid_from }).success).toBe(false)
    expect(createConsentArtifactSchema.safeParse({ ...valid, valid_to: '2026-09-01T00:00:00Z' }).success).toBe(false)
  })

  it('validates the reference, categories and identifier', () => {
    expect(createConsentArtifactSchema.safeParse({ ...valid, artifact_ref: 'has space' }).success).toBe(false)
    expect(createConsentArtifactSchema.safeParse({ ...valid, artifact_ref: '' }).success).toBe(false)
    expect(createConsentArtifactSchema.safeParse({ ...valid, categories: [] }).success).toBe(false)
    expect(createConsentArtifactSchema.safeParse({ ...valid, categories: ['Everything'] }).success).toBe(false)
    expect(createConsentArtifactSchema.safeParse({ ...valid, patient_identifier: { type: 'abha', value: '1' } }).success).toBe(false)
  })

  it('only allows granted or revoked when seeding', () => {
    expect(createConsentArtifactSchema.safeParse({ ...valid, status: 'revoked' }).success).toBe(true)
    expect(createConsentArtifactSchema.safeParse({ ...valid, status: 'expired' }).success).toBe(false)
    expect(updateConsentArtifactSchema.safeParse({ status: 'revoked' }).success).toBe(true)
    expect(updateConsentArtifactSchema.safeParse({ status: 'nope' }).success).toBe(false)
  })
})

describe('consent navigation entry', () => {
  it('shows only to admins, and only while the stub ledger is in use', () => {
    const labels = (role: Parameters<typeof navItemsForRole>[0], consentStub: boolean) =>
      navItemsForRole(role, { consentStub }).map((item) => item.href)
    expect(labels('admin', true)).toContain('/admin/consent')
    expect(labels('admin', false)).not.toContain('/admin/consent')
    expect(navItemsForRole('admin')).not.toEqual(expect.arrayContaining([expect.objectContaining({ href: '/admin/consent' })]))
    for (const role of ['integration_engineer', 'reviewer', 'viewer'] as const) {
      expect(labels(role, true)).not.toContain('/admin/consent')
    }
  })
})
