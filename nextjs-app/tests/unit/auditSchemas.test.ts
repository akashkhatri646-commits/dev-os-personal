import { describe, expect, it } from 'vitest'
import { auditExportSchema, auditFiltersSchema, auditSearchSchema } from '@/lib/validation/audit'

describe('audit filter schemas', () => {
  it('accepts an empty filter set and defaults the page size', () => {
    expect(auditFiltersSchema.safeParse({}).success).toBe(true)
    expect(auditSearchSchema.parse({}).limit).toBe(50)
  })

  it('validates ids, events and the patient identifier', () => {
    expect(auditFiltersSchema.safeParse({ record_id: 'nope' }).success).toBe(false)
    expect(auditFiltersSchema.safeParse({ events: ['not.an.event'] }).success).toBe(false)
    expect(auditFiltersSchema.safeParse({ events: ['record.committed', 'auth.login'] }).success).toBe(true)
    expect(auditFiltersSchema.safeParse({ patient_identifier: { type: 'abha', value: '123' } }).success).toBe(false)
  })

  it('requires from to be before to', () => {
    expect(
      auditFiltersSchema.safeParse({ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' }).success,
    ).toBe(false)
    expect(
      auditFiltersSchema.safeParse({ from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' }).success,
    ).toBe(true)
  })

  it('caps the page size and requires an export format', () => {
    expect(auditSearchSchema.safeParse({ limit: 101 }).success).toBe(false)
    expect(auditExportSchema.safeParse({}).success).toBe(false)
    expect(auditExportSchema.safeParse({ format: 'csv' }).success).toBe(true)
    expect(auditExportSchema.safeParse({ format: 'xml' }).success).toBe(false)
  })
})
