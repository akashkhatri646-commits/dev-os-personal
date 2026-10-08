/** Finds a cited quote in the page text, ignoring differences in case and spacing. */
export function locateQuote(text: string, quote: string): [number, number] | null {
  const trimmed = quote.trim()
  if (trimmed === '') return null
  const exact = text.indexOf(trimmed)
  if (exact >= 0) return [exact, exact + trimmed.length]
  const pattern = trimmed
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+')
  const match = new RegExp(pattern, 'i').exec(text)
  return match ? [match.index, match.index + match[0].length] : null
}
