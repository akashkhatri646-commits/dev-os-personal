import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => ({}) }))
vi.mock('@/server/config/env', () => ({ requireEnvValue: () => 'test-pepper-value' }))
vi.mock('@/server/services/audit/auditLog', () => ({ appendAuditBestEffort: vi.fn() }))

import { generateSourceKey, hashSourceKey, parseSourceKey } from '@/server/services/sources/sourceKeys'

describe('source API keys', () => {
  it('generates hik_<8>_<40> keys with the prefix embedded', () => {
    const { key, prefix } = generateSourceKey()
    expect(key).toMatch(/^hik_[A-Za-z0-9]{8}_[A-Za-z0-9]{40}$/)
    expect(key.startsWith(`hik_${prefix}_`)).toBe(true)
  })

  it('generates distinct keys', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateSourceKey().key))
    expect(keys.size).toBe(50)
  })

  it('hashes deterministically to 64 hex chars and depends on the pepper', () => {
    const { key } = generateSourceKey()
    const first = hashSourceKey(key, 'pepper-a')
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(hashSourceKey(key, 'pepper-a')).toBe(first)
    expect(hashSourceKey(key, 'pepper-b')).not.toBe(first)
    expect(first).not.toContain(key)
  })

  it('parses valid keys and rejects malformed ones', () => {
    const { key, prefix } = generateSourceKey()
    expect(parseSourceKey(key)).toEqual({ prefix })
    expect(parseSourceKey('hik_short_x')).toBeNull()
    expect(parseSourceKey(`${key}extra`)).toBeNull()
    expect(parseSourceKey('Bearer abc')).toBeNull()
    expect(parseSourceKey('')).toBeNull()
  })
})
