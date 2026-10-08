import { describe, expect, it } from 'vitest'
import { canAccessPage, isPublicPath } from '@/lib/auth/pageAccess'

describe('isPublicPath', () => {
  it.each(['/', '/login', '/auth/callback', '/api/health', '/api/anything'])('%s is public', (path) => {
    expect(isPublicPath(path)).toBe(true)
  })
  it.each(['/records', '/admin/users', '/loginx', '/authentic'])('%s is protected', (path) => {
    expect(isPublicPath(path)).toBe(false)
  })
})

describe('canAccessPage (spec 01 section 3)', () => {
  it('lets only admins into /audit and /admin', () => {
    expect(canAccessPage('admin', '/audit')).toBe(true)
    expect(canAccessPage('admin', '/admin/users')).toBe(true)
    for (const role of ['integration_engineer', 'reviewer', 'viewer'] as const) {
      expect(canAccessPage(role, '/audit')).toBe(false)
      expect(canAccessPage(role, '/admin/users')).toBe(false)
    }
  })

  it('keeps viewers on the dashboard only', () => {
    expect(canAccessPage('viewer', '/dashboard')).toBe(true)
    expect(canAccessPage('viewer', '/records')).toBe(false)
    expect(canAccessPage('viewer', '/records/abc')).toBe(false)
    expect(canAccessPage('viewer', '/ingest')).toBe(false)
  })

  it('limits review pages to reviewers and admins', () => {
    expect(canAccessPage('reviewer', '/review/abc')).toBe(true)
    expect(canAccessPage('integration_engineer', '/review')).toBe(false)
  })

  it('does not match on partial segment names', () => {
    expect(canAccessPage('viewer', '/reviewer-notes')).toBe(true)
  })

  it('applies the thresholds rule before any shorter prefix', () => {
    expect(canAccessPage('integration_engineer', '/settings/thresholds')).toBe(true)
    expect(canAccessPage('reviewer', '/settings/thresholds')).toBe(false)
  })
})
