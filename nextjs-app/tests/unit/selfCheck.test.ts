import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BASE_ENV } from '../support/baseEnv'

const holder = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  missingColumns: [] as string[],
  missingFunctions: [] as string[],
  overdue: 0,
  bucket: true,
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server/config/env', () => ({ getEnv: () => ({ ...BASE_ENV, ...holder.env }) }))

function query(table: string) {
  const state = { column: '*' }
  const builder: Record<string, unknown> = {
    select: (column: string, options?: { head?: boolean }) => {
      state.column = column
      if (options?.head) return builder
      const missing = holder.missingColumns.includes(`${table}.${column}`)
      return { limit: async () => ({ data: [], error: missing ? { code: '42703', message: `column ${column} does not exist` } : null }) }
    },
    limit: () => builder,
    eq: () => builder,
    lt: () => builder,
    then: (resolve: (value: unknown) => void) => resolve({ count: table === 'pipeline_jobs' && state.column === 'id' ? holder.overdue : 5, error: null }),
  }
  return builder
}

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => query(table),
    rpc: async (name: string) =>
      holder.missingFunctions.includes(name)
        ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
        : name === 'get_llm_spend' ? { data: 1.5, error: null } : { data: null, error: { code: '22P02', message: 'invalid input syntax' } },
    storage: { getBucket: async () => ({ error: holder.bucket ? null : { message: 'not found' } }) },
  }),
}))

import { runSelfCheck } from '@/server/services/system/selfCheck'

const find = (result: Awaited<ReturnType<typeof runSelfCheck>>, id: string) => result.groups.flatMap((group) => group.items).find((entry) => entry.id === id)

beforeEach(() => {
  holder.env = { APP_BASE_URL: 'http://localhost:3000', LLM_DAILY_BUDGET_USD: 200, SUPABASE_STORAGE_BUCKET: 'b', WORKER_SECRET: 'w'.repeat(40), LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test', LLM_MODEL_EXTRACTION: 'm' }
  holder.missingColumns = []
  holder.missingFunctions = []
  holder.overdue = 0
  holder.bucket = true
})

describe('system self-check', () => {
  it('passes a correctly set up deployment, with warnings only for optional parts', async () => {
    const result = await runSelfCheck()
    expect(result.ok).toBe(true)
    expect(find(result, 'ocr')?.status).toBe('warn')
    expect(find(result, 'worker-secret')?.status).toBe('ok')
  })

  it('names the unapplied migration when a column or function is missing', async () => {
    holder.missingColumns = ['mapped_resources.flags']
    holder.missingFunctions = ['add_llm_spend']
    const result = await runSelfCheck()
    expect(result.ok).toBe(false)
    expect(find(result, '0004_mapped_resource_flags')).toMatchObject({ status: 'fail' })
    expect(find(result, '0007_safety_controls-functions')?.detail).toContain('add_llm_spend')
  })

  it('reports a missing worker secret, model settings, storage bucket and a stopped worker', async () => {
    holder.env = { APP_BASE_URL: 'http://localhost:3000', LLM_DAILY_BUDGET_USD: 200, SUPABASE_STORAGE_BUCKET: 'b', WORKER_SECRET: undefined, LLM_PROVIDER: undefined, LLM_MODEL_EXTRACTION: undefined }
    holder.bucket = false
    holder.overdue = 3
    const result = await runSelfCheck()
    for (const id of ['worker-secret', 'llm-provider', 'llm-model', 'bucket', 'stale-jobs']) expect(find(result, id)?.status).toBe('fail')
    expect(JSON.stringify(result)).not.toContain('sk-test')
  })
})
