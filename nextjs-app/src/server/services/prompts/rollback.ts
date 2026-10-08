import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { appendAudit } from '@/server/services/audit/auditLog'
import type { AuthUser } from '@/types/domain'
import type { PromptRollbackResult } from '@/types/safety'

interface VersionRow {
  id: string
  version: string
  created_at: string
}

/**
 * Re-activates an earlier prompt version for a component: the named one, or the version created just
 * before the active one. The next record processed uses it (its version id is stored on the record).
 * At most one version is active, so the old one is switched off first and restored if the switch fails.
 */
export async function rollbackPrompt(actor: AuthUser, component: 'extraction' | 'mapping', version: string | undefined): Promise<PromptRollbackResult> {
  const admin = getSupabaseAdmin()
  const { data: active, error: activeError } = await admin.from('prompt_versions').select('id, version, created_at').eq('component', component).eq('active', true).maybeSingle()
  if (activeError) throw new AppError('INTERNAL', 'Failed to load the active prompt.', { cause: activeError })
  if (!active) throw new AppError('CONFLICT', 'No prompt version is active yet.', { reason: 'NO_ACTIVE_VERSION' })
  const current = active as VersionRow

  let target: VersionRow | null = null
  if (version) {
    const { data, error } = await admin.from('prompt_versions').select('id, version, created_at').eq('component', component).eq('version', version).maybeSingle()
    if (error) throw new AppError('INTERNAL', 'Failed to load the prompt version.', { cause: error })
    if (!data) throw new AppError('NOT_FOUND', 'That prompt version does not exist.')
    target = data as VersionRow
  } else {
    const { data, error } = await admin.from('prompt_versions').select('id, version, created_at').eq('component', component).lt('created_at', current.created_at).order('created_at', { ascending: false }).limit(1)
    if (error) throw new AppError('INTERNAL', 'Failed to find the previous prompt version.', { cause: error })
    target = ((data ?? [])[0] as VersionRow | undefined) ?? null
  }
  if (!target) throw new AppError('CONFLICT', 'There is no earlier prompt version to go back to.', { reason: 'NO_PREVIOUS_VERSION' })
  if (target.id === current.id) throw new AppError('CONFLICT', 'That version is already active.', { reason: 'ALREADY_ACTIVE' })

  const { error: offError } = await admin.from('prompt_versions').update({ active: false }).eq('id', current.id)
  if (offError) throw new AppError('INTERNAL', 'Failed to switch off the active prompt.', { cause: offError })
  const { error: onError } = await admin.from('prompt_versions').update({ active: true }).eq('id', target.id)
  if (onError) {
    await admin.from('prompt_versions').update({ active: true }).eq('id', current.id)
    throw new AppError('INTERNAL', 'Failed to activate the earlier prompt.', { cause: onError })
  }

  await appendAudit({
    orgId: actor.orgId,
    actor: { type: 'user', id: actor.userId },
    event: 'prompt.rolled_back',
    payload: { component, from_version: current.version, to_version: target.version },
  })
  return { component, active_version: target.version, previous_version: current.version }
}
