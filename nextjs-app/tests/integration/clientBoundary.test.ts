// Baseline security checks that need no running system (docs/specs/15 §8): server-only code and
// secrets must never be reachable from code that is sent to the browser.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(import.meta.dirname, '../../src')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx)$/.test(entry) ? [full] : []
  })
}

const files = sourceFiles(SRC).map((full) => ({ full, relative: path.relative(SRC, full).split(path.sep).join('/'), text: readFileSync(full, 'utf8') }))

const isClientCode = (file: { relative: string; text: string }) =>
  /^['"]use client['"]/.test(file.text.trimStart()) || file.relative.startsWith('components/') || file.relative.startsWith('hooks/')

/** Import lines that load a module for real (type-only imports are erased and carry nothing to the browser). */
function runtimeImports(text: string): string[] {
  return [...text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1] as string)
}

describe('client code never reaches server-only code', () => {
  const clientFiles = files.filter(isClientCode)

  it('has client files to check', () => {
    expect(clientFiles.length).toBeGreaterThan(40)
  })

  it('imports nothing from the server folder, the admin database client or server-only at runtime', () => {
    const offenders = clientFiles.flatMap((file) =>
      runtimeImports(file.text)
        .filter((source) => source.startsWith('@/server/') || source === 'server-only' || source === '@/lib/supabase/admin' || source === '@/lib/supabase/server')
        .map((source) => `${file.relative} imports ${source}`),
    )
    expect(offenders).toEqual([])
  })

  it('does not read process.env directly (only the public config module may)', () => {
    const offenders = clientFiles.filter((file) => /process\.env\.(?!NEXT_PUBLIC_)/.test(file.text)).map((file) => file.relative)
    expect(offenders).toEqual([])
  })
})

describe('secrets stay on the server', () => {
  const SECRETS = ['SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'WORKER_SECRET', 'SOURCE_KEY_PEPPER', 'PATIENT_ID_HMAC_KEY', 'PATIENT_ID_ENC_KEY', 'ALERT_WEBHOOK_URL']

  it('names no secret variable in any client file', () => {
    const offenders = files.filter(isClientCode).flatMap((file) => SECRETS.filter((name) => file.text.includes(name)).map((name) => `${file.relative} mentions ${name}`))
    expect(offenders).toEqual([])
  })

  it('exposes only NEXT_PUBLIC_ variables through the public config', () => {
    const publicEnv = files.find((file) => file.relative === 'lib/publicEnv.ts')
    expect(publicEnv).toBeDefined()
    const names = [...(publicEnv?.text.matchAll(/process\.env\.([A-Z0-9_]+)/g) ?? [])].map((match) => match[1] as string)
    expect(names.length).toBeGreaterThan(0)
    expect(names.every((name) => name.startsWith('NEXT_PUBLIC_'))).toBe(true)
  })

  it('never logs or returns request bodies or document text from the route wrapper', () => {
    const wrapper = files.find((file) => file.relative === 'lib/api/route.ts')?.text ?? ''
    const logCall = /logger\.info\(\{([^}]*)\}/.exec(wrapper)?.[1] ?? ''
    expect(logCall).not.toMatch(/body|text|payload/)
  })
})
