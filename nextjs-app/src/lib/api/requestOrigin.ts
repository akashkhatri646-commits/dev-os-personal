import { AppError } from '@/lib/api/errors'

/**
 * The address of the caller. Hosting-provided headers come first because a client can write anything into
 * `x-forwarded-for`; its first entry is only a last resort.
 */
export function clientIp(req: Request): string {
  const trusted = req.headers.get('x-nf-client-connection-ip') ?? req.headers.get('x-real-ip')
  if (trusted) return trusted.trim()
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const NON_BROWSER_CREDENTIALS = ['authorization', 'x-source-key', 'x-worker-secret']

/**
 * Refuses a state-changing request that a browser sent from another website. Browsers always send `Origin` on such
 * requests; scripts and feeds that authenticate with a header (Bearer token, source key, worker secret) are not
 * affected. This backs up the SameSite cookie setting rather than replacing it.
 */
export function assertSameOrigin(req: Request, allowedHosts: readonly (string | null | undefined)[]): void {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return
  if (NON_BROWSER_CREDENTIALS.some((name) => req.headers.has(name))) return
  const origin = req.headers.get('origin')
  if (!origin) return

  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    throw new AppError('FORBIDDEN', 'Cross-site request refused.', { reason: 'CROSS_SITE' })
  }
  const allowed = allowedHosts.filter((host): host is string => !!host).map((host) => host.toLowerCase())
  if (!allowed.includes(originHost.toLowerCase())) {
    throw new AppError('FORBIDDEN', 'Cross-site request refused.', { reason: 'CROSS_SITE' })
  }
}

/** The hosts this app is legitimately served from: the one in the request and the configured public address. */
export function allowedHosts(req: Request, appBaseUrl: string | undefined): string[] {
  const hosts = [req.headers.get('host'), req.headers.get('x-forwarded-host')]
  try {
    if (appBaseUrl) hosts.push(new URL(appBaseUrl).host)
  } catch {
    // An unusable base URL only narrows the list.
  }
  return hosts.filter((host): host is string => !!host)
}
