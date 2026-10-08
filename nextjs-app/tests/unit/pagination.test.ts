import { describe, expect, it } from 'vitest'
import { AppError } from '@/lib/api/errors'
import {
  buildPage,
  cursorFilter,
  decodeCursor,
  encodeCursor,
  paginationQuerySchema,
} from '@/lib/api/pagination'

const cursor = { createdAt: '2026-10-07T11:00:00.123456+00:00', id: 'abc-123' }

describe('cursor encoding', () => {
  it('round-trips', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  it('rejects tampered or malformed cursors with VALIDATION_FAILED', () => {
    expect(() => decodeCursor('###')).toThrow(AppError)
    expect(() => decodeCursor(Buffer.from('["not-a-date","x"]').toString('base64url'))).toThrow(AppError)
  })

  it('builds a keyset filter for (created_at desc, id desc)', () => {
    expect(cursorFilter(cursor)).toBe(
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
    )
  })
})

describe('buildPage', () => {
  const rows = [3, 2, 1].map((n) => ({ id: `id-${n}`, created_at: `2026-10-0${n}T00:00:00+00:00` }))

  it('returns a next cursor only when more rows exist', () => {
    const page = buildPage(rows, 2)
    expect(page.items).toHaveLength(2)
    expect(decodeCursor(page.nextCursor as string).id).toBe('id-2')
    expect(buildPage(rows, 3).nextCursor).toBeNull()
  })

  it('handles an empty result', () => {
    expect(buildPage([], 25)).toEqual({ items: [], nextCursor: null })
  })
})

describe('paginationQuerySchema', () => {
  it('defaults to 25 and caps at 100', () => {
    expect(paginationQuerySchema.parse({}).limit).toBe(25)
    expect(paginationQuerySchema.safeParse({ limit: '101' }).success).toBe(false)
    expect(paginationQuerySchema.parse({ limit: '10' }).limit).toBe(10)
  })
})
