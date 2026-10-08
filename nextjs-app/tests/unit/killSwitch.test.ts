import { afterEach, describe, expect, it, vi } from 'vitest'

const original = { ...process.env }

async function readSwitch(value: string | undefined): Promise<boolean> {
  vi.resetModules()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
  if (value === undefined) delete process.env.SYSTEM_AUTOCOMMIT_ENABLED
  else process.env.SYSTEM_AUTOCOMMIT_ENABLED = value
  const { getEnv } = await import('@/server/config/env')
  return getEnv().SYSTEM_AUTOCOMMIT_ENABLED
}

afterEach(() => {
  process.env = { ...original }
})

describe('SYSTEM_AUTOCOMMIT_ENABLED (global kill switch)', () => {
  it('is on only for the word true, in any case', async () => {
    expect(await readSwitch('true')).toBe(true)
    expect(await readSwitch(' TRUE ')).toBe(true)
  })

  it('is off when unset, blank, false or anything unparsable', async () => {
    for (const value of [undefined, '', 'false', 'yes', '1', 'on', 'enabled', 'tru']) {
      expect(await readSwitch(value)).toBe(false)
    }
  })
})
