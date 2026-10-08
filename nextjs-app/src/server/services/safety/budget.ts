import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getEnv } from '@/server/config/env'
import { sendAlert } from '@/server/services/alerts/alerts'

/** When the day's cap is reached, model work waits this long before trying again. */
export const BUDGET_DEFER_SECONDS = 15 * 60

/** The day's cap in dollars; 0 or less switches the cap off. */
const cap = () => getEnv().LLM_DAILY_BUDGET_USD

/** True when today's model spend (UTC day) has reached `LLM_DAILY_BUDGET_USD`. */
export async function budgetExceeded(): Promise<boolean> {
  const limit = cap()
  if (!(limit > 0)) return false
  const { data, error } = await getSupabaseAdmin().rpc('get_llm_spend')
  if (error) throw new AppError('INTERNAL', 'Failed to read today\'s model spend.', { cause: error, retryable: true })
  return Number(data ?? 0) >= limit
}

/** Adds a model call's cost to today's total, and alerts once when the cap is crossed. */
export async function recordSpend(usd: number): Promise<void> {
  if (!(usd > 0)) return
  const { data, error } = await getSupabaseAdmin().rpc('add_llm_spend', { p_usd: usd })
  if (error) throw new AppError('INTERNAL', 'Failed to record the model spend.', { cause: error, retryable: true })
  const [before, after] = (data as number[] | null) ?? []
  const limit = cap()
  if (limit > 0 && Number(before) < limit && Number(after) >= limit) {
    await sendAlert({ kind: 'budget_reached', message: `The daily model spend cap ($${limit}) was reached. Model work is paused until tomorrow (UTC) or the cap is raised.` })
  }
}
