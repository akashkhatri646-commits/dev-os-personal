import 'server-only'
import { getEnv } from '@/server/config/env'
import { logger } from '@/server/logger'

export interface AlertMessage {
  /** Short machine-readable kind, e.g. `audit_chain_broken`. */
  kind: string
  /** One human-readable line. Ids and reason codes only: never patient data. */
  message: string
}

/**
 * Posts an alert to the configured webhook (Slack/Teams style `{ text }` body). Delivery problems
 * are logged and swallowed: an alert must never break the work that raised it.
 */
export async function sendAlert(alert: AlertMessage): Promise<void> {
  const url = getEnv().ALERT_WEBHOOK_URL
  logger.warn({ alert_kind: alert.kind }, alert.message)
  if (!url) return
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `[health-ingest] ${alert.message}` }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) logger.warn({ status: response.status }, 'alert webhook returned an error status')
  } catch (error) {
    logger.warn({ err: error }, 'alert webhook delivery failed')
  }
}
