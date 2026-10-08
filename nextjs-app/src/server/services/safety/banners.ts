import 'server-only'
import type { SystemBannerMessage } from '@/components/layout/SystemBanner'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getEnv } from '@/server/config/env'
import { getRuntimeConfig } from '@/server/config/constants'
import { logger } from '@/server/logger'
import { getBreakerState } from '@/server/services/safety/breaker'
import type { AuthUser } from '@/types/domain'

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * Standing warnings for the top of every page: auto-commit switched off, processing delayed by a
 * provider problem, the daily spend cap reached, paused sources and open downstream errors. A banner
 * that cannot be worked out is left out: this must never stop a page from loading.
 */
export async function getSystemBanners(user: Pick<AuthUser, 'orgId' | 'role'>): Promise<SystemBannerMessage[]> {
  const banners: SystemBannerMessage[] = []
  try {
    if (!getRuntimeConfig().systemAutoCommitEnabled) {
      banners.push({ id: 'kill-switch', tone: 'warning', message: 'Auto-commit is switched off for the whole system. Every record goes to review.' })
    }
    if ((await getBreakerState()).open) {
      banners.push({ id: 'breaker', tone: 'warning', message: 'Processing delayed (upstream provider issue). It resumes automatically.' })
    }

    const admin = getSupabaseAdmin()
    const budget = getEnv().LLM_DAILY_BUDGET_USD
    if (budget > 0) {
      const { data } = await admin.rpc('get_llm_spend')
      if (Number(data ?? 0) >= budget) banners.push({ id: 'budget', tone: 'warning', message: 'The daily model spend cap was reached. Model work waits until tomorrow (UTC) or the cap is raised.' })
    }

    if (user.role === 'admin' || user.role === 'integration_engineer') {
      const { count } = await admin.from('provider_sources').select('id', { count: 'exact', head: true }).eq('org_id', user.orgId).not('pause_reason', 'is', null)
      if ((count ?? 0) > 0) banners.push({ id: 'paused-sources', tone: 'warning', message: `Auto-commit is paused for ${plural(count ?? 0, 'source', 'sources')}.` })
    }
    if (user.role === 'admin') {
      const { count } = await admin.from('downstream_errors').select('id', { count: 'exact', head: true }).eq('org_id', user.orgId).neq('status', 'resolved')
      if ((count ?? 0) > 0) banners.push({ id: 'incidents', tone: 'danger', message: `${plural(count ?? 0, 'open downstream error', 'open downstream errors')}. Open Incidents to review ${count === 1 ? 'it' : 'them'}.` })
    }
  } catch (error) {
    logger.warn({ err: error }, 'system banners unavailable')
  }
  return banners
}
