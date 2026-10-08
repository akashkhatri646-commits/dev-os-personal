/**
 * Accepts only same-origin relative paths for post-login redirects, preventing open redirects
 * such as `//evil.example` or `https://evil.example`. Returns `fallback` for anything else.
 */
export function safeRedirectPath(candidate: string | null | undefined, fallback: string): string {
  if (!candidate) return fallback
  if (!candidate.startsWith('/')) return fallback
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return fallback
  if (/[\u0000-\u001f\\]/.test(candidate)) return fallback
  return candidate
}
