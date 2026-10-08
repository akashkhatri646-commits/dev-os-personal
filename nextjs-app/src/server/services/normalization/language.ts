/** Minimum text length for a language guess to mean anything. Shorter text is not judged. */
export const MIN_LANGUAGE_CHARS = 100
const SAMPLE_CHARS = 4000

/**
 * English and the main Indian languages. Detection is restricted to this set so ordinary English
 * clinical text is not mistaken for an unrelated language (a known weakness of unrestricted detection).
 */
const CANDIDATES = ['eng', 'hin', 'ben', 'tam', 'tel', 'mar', 'guj', 'kan', 'mal', 'pan', 'urd', 'ory'] as const

/** English counts unless another candidate beats it by a clear margin (English score below this). */
const ENGLISH_MARGIN = 0.8

export type LanguageVerdict = { supported: true } | { supported: false; detected: string }

/**
 * The MVP supports English only. Returns unsupported when another language clearly dominates the
 * text; text too short to judge, and unclear cases, are treated as English so they are not rejected
 * on a guess.
 */
export async function checkLanguage(text: string): Promise<LanguageVerdict> {
  const sample = text.slice(0, SAMPLE_CHARS)
  if (sample.trim().length < MIN_LANGUAGE_CHARS) return { supported: true }

  const { francAll } = await import('franc-min')
  const ranked = francAll(sample, { minLength: MIN_LANGUAGE_CHARS, only: [...CANDIDATES] })
  const top = ranked[0]
  if (!top || top[0] === 'und' || top[0] === 'eng') return { supported: true }

  const english = ranked.find(([language]) => language === 'eng')?.[1] ?? 0
  return english >= ENGLISH_MARGIN ? { supported: true } : { supported: false, detected: top[0] }
}
