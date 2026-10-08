// A query key must always hold one data shape. An infinite query caches `{ pages, pageParams }` and a
// plain query caches the data itself, so sharing a key makes the page that loads second crash.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(import.meta.dirname, '../../src')

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry)
    if (statSync(full).isDirectory()) return files(full)
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

describe('query keys', () => {
  it('are never used by both an infinite query and a plain query', () => {
    const uses = new Map<string, { infinite: string[]; plain: string[] }>()
    for (const file of files(SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/(useInfiniteQuery|useQuery)\(\{\s*queryKey:\s*queryKeys\.(\w+)/g)) {
        const key = match[2] as string
        const entry = uses.get(key) ?? { infinite: [], plain: [] }
        entry[match[1] === 'useInfiniteQuery' ? 'infinite' : 'plain'].push(path.relative(SRC, file))
        uses.set(key, entry)
      }
    }
    const clashes = [...uses.entries()].filter(([, entry]) => entry.infinite.length > 0 && entry.plain.length > 0).map(([key, entry]) => `queryKeys.${key}: infinite in ${entry.infinite.join(', ')}; plain in ${entry.plain.join(', ')}`)
    expect(clashes).toEqual([])
    expect(uses.size).toBeGreaterThan(5)
  })
})
