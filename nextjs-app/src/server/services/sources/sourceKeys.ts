import 'server-only'
import { createHash, randomInt } from 'node:crypto'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { requireEnvValue } from '@/server/config/env'
import { appendAuditBestEffort } from '@/server/services/audit/auditLog'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const PREFIX_LENGTH = 8
const SECRET_LENGTH = 40
const KEY_PATTERN = /^hik_([A-Za-z0-9]{8})_([A-Za-z0-9]{40})$/

function randomString(length: number): string {
  let value = ''
  for (let index = 0; index < length; index += 1) value += ALPHABET[randomInt(ALPHABET.length)]
  return value
}

/** Key format `hik_<8-char prefix>_<40 chars>`; the prefix is stored in clear for identification. */
export function generateSourceKey(): { key: string; prefix: string } {
  const prefix = randomString(PREFIX_LENGTH)
  return { key: `hik_${prefix}_${randomString(SECRET_LENGTH)}`, prefix }
}

/** SHA-256 over pepper + key, hex encoded. Only this hash is ever stored. */
export function hashSourceKey(key: string, pepper = requireEnvValue('SOURCE_KEY_PEPPER')): string {
  return createHash('sha256').update(`${pepper}${key}`).digest('hex')
}

/** Splits a presented key into its prefix, or null if the format is invalid. */
export function parseSourceKey(key: string): { prefix: string } | null {
  const match = KEY_PATTERN.exec(key)
  return match?.[1] ? { prefix: match[1] } : null
}

export interface SourcePrincipal {
  sourceId: string
  orgId: string
  keyId: string
}

/**
 * Authenticates a feed integration by its `X-Source-Key` header. Lookup is by the peppered hash of
 * the whole key, so no secret comparison happens on the plaintext. Rejections of well-formed but
 * unknown/revoked keys are audited against the source that owns the prefix (prefix only, never the key).
 */
export async function authenticateSourceKey(header: string | null | undefined): Promise<SourcePrincipal> {
  const unauthenticated = () => new AppError('UNAUTHENTICATED', 'Invalid source key.')
  if (!header) throw unauthenticated()
  const parsed = parseSourceKey(header.trim())
  if (!parsed) throw unauthenticated()

  const admin = getSupabaseAdmin()
  const { data, error } = await admin
    .from('source_api_keys')
    .select('id, source_id, provider_sources!inner(org_id)')
    .eq('key_hash', hashSourceKey(header.trim()))
    .is('revoked_at', null)
    .maybeSingle()
  if (error) throw new AppError('INTERNAL', 'Could not verify the source key.', { cause: error })

  if (!data) {
    const { data: owner } = await admin
      .from('source_api_keys')
      .select('source_id, provider_sources!inner(org_id)')
      .eq('key_prefix', parsed.prefix)
      .limit(1)
      .maybeSingle()
    const ownerSource = owner?.provider_sources as { org_id: string } | { org_id: string }[] | null | undefined
    const orgId = Array.isArray(ownerSource) ? ownerSource[0]?.org_id : ownerSource?.org_id
    if (owner && orgId) {
      await appendAuditBestEffort({
        orgId,
        actor: { type: 'system' },
        event: 'source.key_rejected',
        payload: { source_id: owner.source_id, key_prefix: parsed.prefix },
      })
    }
    throw unauthenticated()
  }

  const source = data.provider_sources as { org_id: string } | { org_id: string }[]
  const orgId = Array.isArray(source) ? source[0]?.org_id : source.org_id
  if (!orgId) throw unauthenticated()
  return { sourceId: data.source_id as string, orgId, keyId: data.id as string }
}
