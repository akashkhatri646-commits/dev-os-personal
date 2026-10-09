// API authorisation matrix (docs/specs/15 §4.1): every route × every role. The expected roles are
// written out by hand from the specs, so a route that is added or loosened without updating this table
// fails the "every route is listed" check or its own row.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { holder } = vi.hoisted(() => ({ holder: { user: null as unknown, db: null as unknown as import('../support/fakeDb').FakeDb } }))

vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => holder.db.client() }))
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: () => holder.db.client() }))
vi.mock('@/server/config/env', async () => {
  const { BASE_ENV } = await import('../support/baseEnv')
  return { getEnv: () => ({ ...BASE_ENV, RATE_LIMIT_USER_PER_MIN: 1_000_000 }) }
})
vi.mock('@/server/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/auth/withAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/withAuth')>()),
  getAuthUser: async () => holder.user,
}))

import { FakeDb } from '../support/fakeDb'
import { ROLES, type Role } from '@/types/domain'

const ALL: readonly Role[] = ROLES
const IE_ADMIN: readonly Role[] = ['integration_engineer', 'admin']
const IE_REVIEWER_ADMIN: readonly Role[] = ['integration_engineer', 'reviewer', 'admin']
const REVIEWER_ADMIN: readonly Role[] = ['reviewer', 'admin']
const ADMIN: readonly Role[] = ['admin']

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'

/** [route file under src/app, method, roles allowed]. */
const MATRIX: [string, Method, readonly Role[]][] = [
  ['api/me/route.ts', 'GET', ALL],
  ['api/sources/route.ts', 'GET', ALL],
  ['api/metrics/sources/route.ts', 'GET', ALL],
  ['api/sources/route.ts', 'POST', IE_ADMIN],
  ['api/sources/[id]/route.ts', 'GET', ALL],
  ['api/sources/[id]/route.ts', 'PATCH', IE_ADMIN],
  ['api/sources/[id]/thresholds/route.ts', 'PUT', IE_ADMIN],
  ['api/sources/[id]/thresholds/history/route.ts', 'GET', IE_ADMIN],
  ['api/sources/[id]/enable-auto-commit/route.ts', 'POST', ADMIN],
  ['api/sources/[id]/pause/route.ts', 'POST', ADMIN],
  ['api/sources/[id]/evaluation/route.ts', 'GET', IE_ADMIN],
  ['api/sources/[id]/run-eval/route.ts', 'POST', ADMIN],
  ['api/sources/[id]/resume/route.ts', 'POST', ADMIN],
  ['api/sources/[id]/rotate-key/route.ts', 'POST', ADMIN],
  ['api/sources/[id]/flag-poor/route.ts', 'POST', REVIEWER_ADMIN],
  ['api/ingestions/route.ts', 'GET', IE_REVIEWER_ADMIN],
  ['api/ingestions/[id]/route.ts', 'GET', IE_REVIEWER_ADMIN],
  ['api/ingestions/[id]/trace/route.ts', 'GET', IE_REVIEWER_ADMIN],
  ['api/ingestions/[id]/document/route.ts', 'GET', IE_REVIEWER_ADMIN],
  ['api/ingestions/[id]/retry/route.ts', 'POST', IE_ADMIN],
  ['api/review-tasks/route.ts', 'GET', REVIEWER_ADMIN],
  ['api/review-tasks/[id]/route.ts', 'GET', REVIEWER_ADMIN],
  ['api/review-tasks/[id]/claim/route.ts', 'POST', REVIEWER_ADMIN],
  ['api/review-tasks/[id]/heartbeat/route.ts', 'POST', REVIEWER_ADMIN],
  ['api/review-tasks/[id]/release/route.ts', 'POST', REVIEWER_ADMIN],
  ['api/review-tasks/[id]/submit/route.ts', 'POST', REVIEWER_ADMIN],
  ['api/review-tasks/[id]/request-reupload/route.ts', 'POST', REVIEWER_ADMIN],
  ['api/terminology/search/route.ts', 'GET', REVIEWER_ADMIN],
  ['api/records/[id]/error-report/route.ts', 'POST', REVIEWER_ADMIN],
  ['api/downstream-errors/route.ts', 'GET', ADMIN],
  ['api/downstream-errors/[id]/route.ts', 'PATCH', ADMIN],
  ['api/fhir/[resourceType]/route.ts', 'GET', IE_ADMIN],
  ['api/fhir/[resourceType]/[id]/route.ts', 'GET', IE_REVIEWER_ADMIN],
  ['api/fhir/Provenance/[id]/route.ts', 'GET', IE_REVIEWER_ADMIN],
  ['api/audit/search/route.ts', 'POST', ADMIN],
  ['api/audit/export/route.ts', 'POST', ADMIN],
  ['api/audit/verify/route.ts', 'GET', ADMIN],
  ['api/audit/records/[id]/route.ts', 'GET', ADMIN],
  ['api/admin/system/check/route.ts', 'GET', ADMIN],
  ['api/admin/records/[id]/rerun/route.ts', 'POST', ADMIN],
  ['api/admin/users/route.ts', 'GET', ADMIN],
  ['api/admin/users/route.ts', 'POST', ADMIN],
  ['api/admin/users/[id]/route.ts', 'PATCH', ADMIN],
  ['api/admin/consent-artifacts/route.ts', 'GET', ADMIN],
  ['api/admin/consent-artifacts/route.ts', 'POST', ADMIN],
  ['api/admin/consent-artifacts/[id]/route.ts', 'PATCH', ADMIN],
  ['api/admin/prompts/[component]/rollback/route.ts', 'POST', ADMIN],
  ['api/admin/llm/check/route.ts', 'POST', ADMIN],
  ['api/admin/records/bulk-review/route.ts', 'POST', ADMIN],
  ['api/admin/sources/pause-all/route.ts', 'POST', ADMIN],
]

/** Routes that authenticate themselves (a secret, a source key, or not at all) and are tested separately. */
const SELF_AUTHENTICATED = [
  'api/auth/login/route.ts',
  'api/auth/magic-link/route.ts',
  'api/auth/logout/route.ts',
  'api/health/route.ts',
  'api/ingestions/route.ts#POST',
  'api/internal/audit/verify/route.ts',
  'api/internal/config-check/route.ts',
  'api/worker/tick/route.ts',
  'auth/callback/route.ts',
]

const PARAMS = { id: '3f2b1c0e-6f6e-4c5d-9e0a-0a1b2c3d4e5f', resourceType: 'MedicationRequest', component: 'extraction' }
const APP = path.resolve(import.meta.dirname, '../../src/app')

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry)
    if (statSync(full).isDirectory()) return routeFiles(full)
    return entry === 'route.ts' ? [path.relative(APP, full).split(path.sep).join('/')] : []
  })
}

const userWithRole = (role: Role) => ({ userId: `${role}-1`, email: null, orgId: 'org-1', orgName: null, fullName: null, role })

async function call(file: string, method: Method, role: Role | null): Promise<number> {
  holder.user = role ? userWithRole(role) : null
  const module = (await import(/* @vite-ignore */ `../../src/app/${file}`)) as Record<string, (request: NextRequest, context: { params: unknown }) => Promise<Response>>
  const handler = module[method]
  if (!handler) throw new Error(`${file} has no ${method}`)
  const url = file.startsWith('api/fhir') || file.includes('terminology') ? 'http://localhost/x?q=metformin&system=snomed&resource_type=Condition' : 'http://localhost/x'
  const response = await handler(new NextRequest(url, { method }), { params: PARAMS })
  return response.status
}

beforeEach(() => {
  holder.db = new FakeDb()
})

describe('every route is covered by this matrix', () => {
  it('lists each exported method of each route file, or names the route as self-authenticated', () => {
    const files = routeFiles(path.join(APP))
    const listed = new Set(MATRIX.map(([file, method]) => `${file}#${method}`))
    for (const file of files) {
      const source = readFileSync(path.join(APP, file), 'utf8')
      const methods = [...source.matchAll(/^export const (GET|POST|PATCH|PUT|DELETE) =/gm)].map((match) => match[1] as string)
      for (const method of methods) {
        const covered = listed.has(`${file}#${method}`) || SELF_AUTHENTICATED.includes(file) || SELF_AUTHENTICATED.includes(`${file}#${method}`)
        expect(covered, `${method} ${file} is not in the authorisation matrix`).toBe(true)
      }
    }
  })

  it('has no row for a route that does not exist', () => {
    const files = new Set(routeFiles(path.join(APP)))
    for (const [file] of MATRIX) expect(files.has(file), `${file} is listed but missing`).toBe(true)
  })
})

describe('API authorisation matrix', () => {
  it.each(MATRIX)('%s %s: only the listed roles get past the role check; nobody unauthenticated does', async (file, method, allowed) => {
    expect(await call(file, method, null)).toBe(401)
    for (const role of ALL) {
      const status = await call(file, method, role)
      if (allowed.includes(role)) expect(status, `${role} should be allowed on ${method} ${file}`).not.toBe(403)
      else expect(status, `${role} should be refused on ${method} ${file}`).toBe(403)
      if (allowed.includes(role)) expect(status, `${role} should be authenticated on ${method} ${file}`).not.toBe(401)
    }
  })
})
