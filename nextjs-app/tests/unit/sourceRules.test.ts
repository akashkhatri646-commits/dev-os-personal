import { describe, expect, it } from 'vitest'
import { resolveThreshold, thresholdFloor } from '@/lib/sources/rules'
import { safeNote } from '@/lib/validation/phi'
import { createSourceSchema, setThresholdSchema, updateSourceSchema } from '@/lib/validation/sources'

describe('resolveThreshold (spec 02: exact type, then default, then 1.0)', () => {
  const rows = [
    { resource_type: '*', threshold: 0.97, version: 1 },
    { resource_type: 'MedicationRequest', threshold: 0.99, version: 3 },
  ]

  it('prefers the exact resource type', () => {
    expect(resolveThreshold(rows, 'MedicationRequest')).toEqual({ threshold: 0.99, version: 3 })
  })

  it('falls back to the default row', () => {
    expect(resolveThreshold(rows, 'Condition')).toEqual({ threshold: 0.97, version: 1 })
  })

  it('fails closed with 1.0 when nothing is configured', () => {
    expect(resolveThreshold([], 'Condition')).toEqual({ threshold: 1, version: null })
    expect(resolveThreshold([{ resource_type: 'Condition', threshold: 0.9, version: 1 }], 'Encounter')).toEqual({
      threshold: 1,
      version: null,
    })
  })
})

describe('thresholdFloor', () => {
  it('is 0.95 for medication and allergy and 0.5 otherwise', () => {
    expect(thresholdFloor('MedicationRequest')).toBe(0.95)
    expect(thresholdFloor('AllergyIntolerance')).toBe(0.95)
    expect(thresholdFloor('Condition')).toBe(0.5)
    expect(thresholdFloor('*')).toBe(0.5)
  })
})

describe('setThresholdSchema', () => {
  const valid = { resource_type: 'Condition', threshold: 0.9, reason: 'tuned after review' }

  it('accepts a normal change', () => {
    expect(setThresholdSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects a medication threshold below the safety floor with a THRESHOLD_TOO_LOW reason', () => {
    const result = setThresholdSchema.safeParse({ ...valid, resource_type: 'MedicationRequest', threshold: 0.9 })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue?.path).toEqual(['threshold'])
      expect(issue?.code === 'custom' && issue.params?.reason).toBe('THRESHOLD_TOO_LOW')
    }
  })

  it('enforces global bounds and unknown resource types', () => {
    expect(setThresholdSchema.safeParse({ ...valid, threshold: 0.4 }).success).toBe(false)
    expect(setThresholdSchema.safeParse({ ...valid, threshold: 1 }).success).toBe(false)
    expect(setThresholdSchema.safeParse({ ...valid, resource_type: 'Patient' }).success).toBe(false)
  })

  it('requires a reason of at least 5 characters without personal data', () => {
    expect(setThresholdSchema.safeParse({ ...valid, reason: 'ok' }).success).toBe(false)
    expect(setThresholdSchema.safeParse({ ...valid, reason: 'ask ada@example.com to check' }).success).toBe(false)
    expect(setThresholdSchema.safeParse({ ...valid, reason: 'patient 9876543210 complained' }).success).toBe(false)
  })
})

describe('safeNote', () => {
  it('trims, bounds length and blocks emails and long digit runs', () => {
    const schema = safeNote(5, 20)
    expect(schema.parse('  fine note  ')).toBe('fine note')
    expect(schema.safeParse('abc').success).toBe(false)
    expect(schema.safeParse('x'.repeat(21)).success).toBe(false)
    expect(schema.safeParse('mail me a@b.co').success).toBe(false)
  })
})

describe('createSourceSchema / updateSourceSchema', () => {
  const base = { name: 'City Hospital', provider_type: 'hospital', size_class: 'large', doc_types: ['discharge_summary'] }

  it('applies defaults for language and consent regime', () => {
    const parsed = createSourceSchema.parse(base)
    expect(parsed.primary_language).toBe('en')
    expect(parsed.consent_regime).toBe('abdm')
  })

  it('treats an empty optional region as not set', () => {
    expect(createSourceSchema.parse({ ...base, region: '' }).region).toBeUndefined()
    expect(createSourceSchema.parse({ ...base, region: ' Mumbai ' }).region).toBe('Mumbai')
  })

  it('rejects short names, empty doc types and bad language codes', () => {
    expect(createSourceSchema.safeParse({ ...base, name: 'A' }).success).toBe(false)
    expect(createSourceSchema.safeParse({ ...base, doc_types: [] }).success).toBe(false)
    expect(createSourceSchema.safeParse({ ...base, primary_language: 'english' }).success).toBe(false)
  })

  it('requires at least one field to update and bounds holdback', () => {
    expect(updateSourceSchema.safeParse({}).success).toBe(false)
    expect(updateSourceSchema.safeParse({ holdback_pct: 101 }).success).toBe(false)
    expect(updateSourceSchema.safeParse({ holdback_pct: 10 }).success).toBe(true)
  })
})
