import { describe, expect, it } from 'vitest'
import { safeRedirectPath } from '@/lib/auth/safeRedirect'

describe('safeRedirectPath', () => {
  it('allows same-origin relative paths with query strings', () => {
    expect(safeRedirectPath('/records/123?tab=fields', '/x')).toBe('/records/123?tab=fields')
  })

  it.each([
    ['//evil.example', 'protocol-relative URL'],
    ['https://evil.example', 'absolute URL'],
    ['/\\evil.example', 'backslash trick'],
    ['javascript:alert(1)', 'script scheme'],
    ['/ok\r\nLocation: https://evil.example', 'header injection'],
    ['records', 'no leading slash'],
  ])('rejects %s (%s)', (candidate) => {
    expect(safeRedirectPath(candidate, '/fallback')).toBe('/fallback')
  })

  it('falls back for null and empty values', () => {
    expect(safeRedirectPath(null, '/fallback')).toBe('/fallback')
    expect(safeRedirectPath('', '/fallback')).toBe('/fallback')
  })
})
