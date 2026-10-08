import { z } from 'zod'
import { AppError } from '@/lib/api/errors'

export const DEFAULT_PAGE_LIMIT = 25
export const MAX_PAGE_LIMIT = 100

/** Query schema shared by every list endpoint: `?limit=25&cursor=<opaque>` (spec 00 §6). */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().min(1).max(512).optional(),
})
export type PaginationQuery = z.infer<typeof paginationQuerySchema>

export interface Cursor {
  /** ISO-8601 timestamp of the last row returned. */
  createdAt: string
  id: string
}

function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8')
}

export function encodeCursor(cursor: Cursor): string {
  return toBase64Url(JSON.stringify([cursor.createdAt, cursor.id]))
}

export function decodeCursor(raw: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(raw))
    const tuple = z.tuple([z.iso.datetime({ offset: true }), z.string().min(1)]).parse(parsed)
    return { createdAt: tuple[0], id: tuple[1] }
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Invalid pagination cursor.', {
      details: [{ path: ['cursor'], message: 'Invalid cursor' }],
    })
  }
}

/**
 * PostgREST `.or()` expression selecting rows strictly after `cursor` for a
 * (created_at desc, id desc) ordering.
 */
export function cursorFilter(cursor: Cursor): string {
  return `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
}

/**
 * Trims a page fetched with `limit + 1` rows and derives the next cursor.
 * Rows must be ordered by (created_at desc, id desc).
 */
export function buildPage<T extends { created_at: string; id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items[items.length - 1]
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  }
}
