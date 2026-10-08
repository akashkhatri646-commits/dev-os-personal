const MAX_LENGTH = 100

/**
 * Reduces a client-supplied file name to a safe storage name: path components are dropped and only
 * `[A-Za-z0-9._-]` survives. Falls back to `document` when nothing usable is left.
 */
export function sanitizeFilename(name: string | null | undefined): string {
  if (!name) return 'document'
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, MAX_LENGTH)
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : 'document'
}
