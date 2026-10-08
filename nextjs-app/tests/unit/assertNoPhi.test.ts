import { describe, expect, it } from 'vitest'
import { assertNoPhi } from '@/server/services/audit/auditLog'

describe('assertNoPhi', () => {
  it('accepts ids, enums and counts', () => {
    expect(() =>
      assertNoPhi({
        user_id: '3f2b8c1e-5c1a-4d6e-9c5e-2f7a1b0d9e11',
        // an all-digit UUID group must not trip the identifier check
        record_id: '3f2b8c1e-5c1a-4d6e-9c5e-123456789012',
        role: 'admin',
        count: 3,
        reasons: ['below_threshold'],
      }),
    ).not.toThrow()
  })

  it('rejects email addresses', () => {
    expect(() => assertNoPhi({ who: 'ada@example.com' })).toThrow()
  })

  it('rejects ABHA-like and phone-like digit runs', () => {
    expect(() => assertNoPhi({ abha: '12345678901234' })).toThrow()
    expect(() => assertNoPhi({ note: 'call 9876543210' })).toThrow()
  })
})
