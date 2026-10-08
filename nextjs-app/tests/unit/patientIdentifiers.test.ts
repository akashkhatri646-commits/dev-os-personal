import { describe, expect, it, vi } from 'vitest'

vi.mock('@/server/config/env', () => ({ requireEnvValue: () => 'test-hmac-key-0123456789abcdef0123' }))

import { normalizePatientIdentifier, patientIdentifierSchema } from '@/lib/validation/patientIdentifier'
import { hashPatientIdentifier } from '@/server/services/patients/patientIdentifiers'

describe('patientIdentifierSchema', () => {
  it('accepts ABHA numbers with or without hyphens', () => {
    expect(patientIdentifierSchema.safeParse({ type: 'abha', value: '12-3456-7890-1234' }).success).toBe(true)
    expect(patientIdentifierSchema.safeParse({ type: 'abha', value: '12345678901234' }).success).toBe(true)
  })

  it('rejects malformed ABHA numbers and addresses', () => {
    expect(patientIdentifierSchema.safeParse({ type: 'abha', value: '1234' }).success).toBe(false)
    expect(patientIdentifierSchema.safeParse({ type: 'abha', value: 'name@abdm' }).success).toBe(false)
    expect(patientIdentifierSchema.safeParse({ type: 'abha', value: '1234567890123x' }).success).toBe(false)
  })

  it('validates MRN characters and length', () => {
    expect(patientIdentifierSchema.safeParse({ type: 'mrn', value: 'MRN-2024/001.A' }).success).toBe(true)
    expect(patientIdentifierSchema.safeParse({ type: 'mrn', value: 'has space' }).success).toBe(false)
    expect(patientIdentifierSchema.safeParse({ type: 'mrn', value: 'x'.repeat(65) }).success).toBe(false)
  })

  it('reports the ABHA_FORMAT reason', () => {
    const result = patientIdentifierSchema.safeParse({ type: 'abha', value: '12' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue?.code === 'custom' && issue.params?.reason).toBe('ABHA_FORMAT')
    }
  })
})

describe('hashPatientIdentifier', () => {
  it('normalises ABHA so hyphenated and plain forms hash identically', () => {
    const hyphenated = hashPatientIdentifier({ type: 'abha', value: '12-3456-7890-1234' })
    const plain = hashPatientIdentifier({ type: 'abha', value: '12345678901234' })
    expect(hyphenated).toBe(plain)
    expect(normalizePatientIdentifier({ type: 'abha', value: '12-3456-7890-1234' })).toBe('12345678901234')
  })

  it('separates identifier types and is a 64-char hex digest that hides the value', () => {
    const abha = hashPatientIdentifier({ type: 'abha', value: '12345678901234' })
    const mrn = hashPatientIdentifier({ type: 'mrn', value: '12345678901234' })
    expect(abha).not.toBe(mrn)
    expect(abha).toMatch(/^[0-9a-f]{64}$/)
    expect(abha).not.toContain('12345678901234')
  })

  it('depends on the key', () => {
    const identifier = { type: 'mrn' as const, value: 'MRN-1' }
    expect(hashPatientIdentifier(identifier, 'key-one')).not.toBe(hashPatientIdentifier(identifier, 'key-two'))
  })
})
