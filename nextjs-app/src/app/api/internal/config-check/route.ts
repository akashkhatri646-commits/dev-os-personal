import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { describeEnvProblems } from '@/server/config/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function authorised(request: NextRequest): boolean {
  const expected = process.env.WORKER_SECRET
  const provided = request.headers.get('x-worker-secret')
  if (!expected || !provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Configuration doctor for first deployments. Deliberately independent of the app's own settings loader and of
 * the `route()` wrapper, so it still answers when a setting is wrong and every other route fails. It reports which
 * variables are invalid, whether the three Supabase settings belong to one project, and whether the database
 * accepts the service key. It reports names, rules and status codes only, never a value. Needs WORKER_SECRET.
 */
export async function GET(request: NextRequest) {
  if (!authorised(request)) return NextResponse.json({ error: 'Not authorised.' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY

  let database: { reachable: boolean; status?: number; problem?: string } = { reachable: false, problem: 'Supabase URL or service key is missing.' }
  if (url && service) {
    try {
      const client = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } })
      const { error, status } = await client.from('profiles').select('id', { head: true, count: 'exact' }).limit(1)
      database = error ? { reachable: false, status, problem: `${error.code ?? 'error'}: ${error.message}` } : { reachable: true, status }
    } catch (error) {
      database = { reachable: false, problem: error instanceof Error ? error.message : 'Could not create the Supabase client.' }
    }
  }

  const projectRef = (value: string | undefined) => {
    try {
      return value ? new URL(value).hostname.split('.')[0] : null
    } catch {
      return null
    }
  }
  // A Supabase JWT key carries its project reference in the payload; compare it with the URL's, without printing either key.
  const keyRef = (key: string | undefined) => {
    try {
      const payload = JSON.parse(Buffer.from((key ?? '').split('.')[1] ?? '', 'base64url').toString('utf8')) as { ref?: string; role?: string }
      return { ref: payload.ref ?? null, role: payload.role ?? null }
    } catch {
      return { ref: null, role: null }
    }
  }
  const urlRef = projectRef(url)
  const anonInfo = keyRef(anon)
  const serviceInfo = keyRef(service)

  return NextResponse.json({
    invalid_variables: describeEnvProblems(),
    supabase: {
      url_project: urlRef,
      anon_key: { present: !!anon, project: anonInfo.ref, role: anonInfo.role },
      service_key: { present: !!service, project: serviceInfo.ref, role: serviceInfo.role },
      same_project: !!urlRef && urlRef === anonInfo.ref && urlRef === serviceInfo.ref,
      anon_is_anon: anonInfo.role === 'anon',
      service_is_service_role: serviceInfo.role === 'service_role',
    },
    database,
    app_base_url_host: (() => {
      try {
        return new URL(process.env.APP_BASE_URL ?? '').host
      } catch {
        return null
      }
    })(),
    worker_secret_length: (process.env.WORKER_SECRET ?? '').length,
  })
}
