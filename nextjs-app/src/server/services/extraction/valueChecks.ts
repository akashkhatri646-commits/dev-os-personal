import { FREQUENCIES, ROUTES, UNITS, type AttributeSpec } from '@/server/services/extraction/fieldCatalog'
import { wordOverlap, wordsOf } from '@/server/services/extraction/textMatch'

/**
 * Checks that a value is genuinely supported by the quote it cites (docs/specs/06 §7 step 3).
 * Every check works on text normalised by `normalizeText` and is deterministic.
 */
export interface ValueCheck {
  ok: boolean
  /** The value converted to its catalogue type (numbers become numbers). */
  value: string | number
  /** The value is implied rather than stated (ranges, ambiguous dates, classifications). */
  forceInferred: boolean
}

const fail = (value: string): ValueCheck => ({ ok: false, value, forceInferred: false })
const pass = (value: string | number, forceInferred = false): ValueCheck => ({ ok: true, value, forceInferred })

/* ------------------------------- numbers ------------------------------- */

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, half: 0.5, quarter: 0.25,
}

/** Every number written in the text: digits, thousands separators, fractions and simple number words. */
export function numbersIn(quoteNorm: string): number[] {
  const numbers: number[] = []
  const cleaned = quoteNorm.replace(/(\d),(\d{3})(?!\d)/g, '$1$2')
  for (const match of cleaned.matchAll(/(\d+)\s*\/\s*(\d+)/g)) {
    const numerator = Number(match[1])
    const denominator = Number(match[2])
    if (denominator !== 0) numbers.push(numerator / denominator)
  }
  for (const match of cleaned.matchAll(/\d+(?:\.\d+)?/g)) numbers.push(Number(match[0]))
  for (const word of wordsOf(cleaned)) {
    const known = NUMBER_WORDS[word]
    if (known !== undefined) numbers.push(known)
  }
  return numbers
}

function parseNumber(value: string): number | null {
  const cleaned = value.replace(/,/g, '').trim()
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null
  return Number(cleaned)
}

export function checkNumber(value: string, quoteNorm: string): ValueCheck {
  const numbers = numbersIn(quoteNorm)

  const range = /^(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)$/.exec(value.trim().toLowerCase())
  if (range) {
    const [low, high] = [Number(range[1]), Number(range[2])]
    // A dose range is stored as text and always treated as inferred: it never auto-commits.
    return numbers.includes(low) && numbers.includes(high) ? pass(`${range[1]}-${range[2]}`, true) : fail(value)
  }

  const parsed = parseNumber(value)
  if (parsed === null) return fail(value)
  return numbers.some((candidate) => Math.abs(candidate - parsed) < 1e-9) ? pass(parsed) : fail(value)
}

/* -------------------------------- dates -------------------------------- */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
}

interface DateParts {
  year: number
  month: number | null
  day: number | null
}

const pad = (value: number) => String(value).padStart(2, '0')

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function fullYear(raw: string): number {
  if (raw.length === 4) return Number(raw)
  const short = Number(raw)
  return short <= 69 ? 2000 + short : 1900 + short
}

/** Parses an ISO date, year-month or year as the model returns it. */
export function parseIsoDate(value: string): DateParts | null {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value.trim())
  if (!match?.[1]) return null
  const year = Number(match[1])
  const month = match[2] ? Number(match[2]) : null
  const day = match[3] ? Number(match[3]) : null
  if (month !== null && (month < 1 || month > 12)) return null
  if (month !== null && day !== null && !isRealDate(year, month, day)) return null
  return { year, month, day }
}

interface DateCandidate {
  parts: DateParts
  /** Both day-first and month-first readings are plausible, so the date is not certain. */
  ambiguous: boolean
}

/** Dates written in the text. Numeric dates are read day-first (India); a month-first reading is used only when day-first is impossible. */
export function datesIn(quoteNorm: string): DateCandidate[] {
  const found: DateCandidate[] = []

  // Year first: 2025-03-01, 2025/03/01, 2025.03.01, and a date followed by a time (2025-03-01T10:30).
  for (const m of quoteNorm.matchAll(/\b(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})(?!\d)/g)) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
    if (isRealDate(year, month, day)) found.push({ parts: { year, month, day }, ambiguous: false })
  }

  // Numeric day, month, year with any of / . - between them, with or without spaces around the separators.
  for (const m of quoteNorm.matchAll(/(?<!\d)(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{4}|\d{2})(?!\d)/g)) {
    const [first, second, year] = [Number(m[1]), Number(m[2]), fullYear(m[3] ?? '')]
    const dayFirst = isRealDate(year, second, first)
    const monthFirst = isRealDate(year, first, second)
    if (dayFirst) found.push({ parts: { year, month: second, day: first }, ambiguous: monthFirst && first !== second })
    else if (monthFirst) found.push({ parts: { year, month: first, day: second }, ambiguous: false })
  }

  // Day, month name, year: 1 March 2025, 1st March, 2025, 01-Mar-25, 01/Mar/2025, 01Mar2025, 5th of March 2025, 5 th March 2025.
  for (const m of quoteNorm.matchAll(/(?<!\d)(\d{1,2})\s*(?:st|nd|rd|th)?(?:\s+of)?[\s/.,-]*([a-z]{3,9})\.?[\s/.,-]*(\d{4}|\d{2})(?!\d)/g)) {
    const month = MONTHS[m[2] ?? '']
    const [day, year] = [Number(m[1]), fullYear(m[3] ?? '')]
    if (month && isRealDate(year, month, day)) found.push({ parts: { year, month, day }, ambiguous: false })
  }

  // Month name, day, year: March 1, 2025, Mar 1st 2025.
  for (const m of quoteNorm.matchAll(/\b([a-z]{3,9})\.?\s+(\d{1,2})\s*(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)/g)) {
    const month = MONTHS[m[1] ?? '']
    const [day, year] = [Number(m[2]), Number(m[3])]
    if (month && isRealDate(year, month, day)) found.push({ parts: { year, month, day }, ambiguous: false })
  }

  // Month name and year only: March 2025.
  for (const m of quoteNorm.matchAll(/\b([a-z]{3,9})\.?,?\s+(\d{4})(?!\d)/g)) {
    const month = MONTHS[m[1] ?? '']
    if (month) found.push({ parts: { year: Number(m[2]), month, day: null }, ambiguous: false })
  }

  for (const m of quoteNorm.matchAll(/(?<!\d)(\d{1,2})\s*[/-]\s*(\d{4})(?!\d)/g)) {
    const [month, year] = [Number(m[1]), Number(m[2])]
    if (month >= 1 && month <= 12) found.push({ parts: { year, month, day: null }, ambiguous: false })
  }

  for (const m of quoteNorm.matchAll(/\b((?:19|20)\d{2})\b/g)) {
    found.push({ parts: { year: Number(m[1]), month: null, day: null }, ambiguous: false })
  }
  return found
}

function matchesParts(wanted: DateParts, candidate: DateParts): boolean {
  if (wanted.year !== candidate.year) return false
  if (wanted.month !== null && wanted.month !== candidate.month) return false
  if (wanted.day !== null && wanted.day !== candidate.day) return false
  return true
}

export function checkDate(value: string, quoteNorm: string): ValueCheck {
  const wanted = parseIsoDate(value)
  if (!wanted) return fail(value)
  const iso = `${wanted.year}${wanted.month !== null ? `-${pad(wanted.month)}` : ''}${wanted.day !== null ? `-${pad(wanted.day)}` : ''}`

  const hit = datesIn(quoteNorm).find((candidate) => matchesParts(wanted, candidate.parts))
  if (!hit) return fail(value)
  // A day-first reading of an ambiguous numeric date is a judgement call, so it is marked inferred.
  return pass(iso, hit.ambiguous)
}

/* -------------------- units, frequencies, routes ---------------------- */

const UNIT_ALIASES: Record<string, (typeof UNITS)[number]> = {
  mg: 'mg', mgs: 'mg', milligram: 'mg', milligrams: 'mg',
  mcg: 'mcg', μg: 'mcg', ug: 'mcg', microgram: 'mcg', micrograms: 'mcg',
  g: 'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g',
  ml: 'ml', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml',
  iu: 'iu', unit: 'unit', units: 'unit',
  tab: 'tablet', tabs: 'tablet', tablet: 'tablet', tablets: 'tablet',
  cap: 'capsule', caps: 'capsule', capsule: 'capsule', capsules: 'capsule',
  drop: 'drop', drops: 'drop', gtt: 'drop', puff: 'puff', puffs: 'puff',
}

/** Letters only, so `500mg` yields the token `mg`. */
function lettersIn(quoteNorm: string): string[] {
  return quoteNorm.match(/[a-zμ]+/g) ?? []
}

export function checkUnit(value: string, quoteNorm: string): ValueCheck {
  const wanted = UNIT_ALIASES[value.trim().toLowerCase()]
  if (!wanted) return fail(value)
  return lettersIn(quoteNorm).some((token) => UNIT_ALIASES[token] === wanted) ? pass(wanted) : fail(value)
}

type Canonical = readonly string[]

const FREQUENCY_PATTERNS: [(typeof FREQUENCIES)[number], RegExp][] = [
  ['once daily', /\b(od|qd|once (a |per )?(day|daily)|1-0-0|1 ?x ?1 daily)\b/],
  ['twice daily', /\b(bd|bid|b\.i\.d|twice (a |per )?(day|daily)|2 times (a |per )?day|1-0-1|1-1-0|0-1-1)\b/],
  ['three times daily', /\b(tds|tid|t\.d\.s|thrice( daily)?|three times (a |per )?(day|daily)|3 times (a |per )?day|1-1-1)\b/],
  ['four times daily', /\b(qid|qds|four times (a |per )?(day|daily)|4 times (a |per )?day|1-1-1-1)\b/],
  ['at bedtime', /\b(hs|at (bed ?time|night)|nocte|bedtime|0-0-1)\b/],
  ['every 8 hours', /\b(q8h|every 8 (hours|hrs)|8[ -]hourly)\b/],
  ['every 12 hours', /\b(q12h|every 12 (hours|hrs)|12[ -]hourly)\b/],
  ['as needed', /\b(sos|prn|as needed|when required|if required|as required)\b/],
  ['weekly', /\b(weekly|once (a |per )?week)\b/],
]

const ROUTE_PATTERNS: [(typeof ROUTES)[number], RegExp][] = [
  ['oral', /\b(po|p\.o|oral(ly)?|by mouth)\b/],
  ['intravenous', /\b(iv|i\.v|intravenous(ly)?)\b/],
  ['intramuscular', /\b(im|i\.m|intramuscular(ly)?)\b/],
  ['subcutaneous', /\b(sc|s\.c|subcut|subcutaneous(ly)?)\b/],
  ['topical', /\b(topical(ly)?)\b/],
  ['inhalation', /\b(inh|inhal(ation|ed)?|nebuli[sz](ed|ation))\b/],
  ['sublingual', /\b(sl|sublingual(ly)?)\b/],
  ['rectal', /\b(pr|rectal(ly)?)\b/],
  ['ophthalmic', /\b(eye drops?|ophthalmic)\b/],
]

function checkCanonical(value: string, quoteNorm: string, patterns: [string, RegExp][], allowed: Canonical): ValueCheck {
  const wanted = value.trim().toLowerCase()
  if (!allowed.includes(wanted)) return fail(value)
  // Only patterns that are recognised count: an unknown abbreviation can never ground a value.
  return patterns.some(([canonical, pattern]) => canonical === wanted && pattern.test(quoteNorm)) ? pass(wanted) : fail(value)
}

export const checkFrequency = (value: string, quoteNorm: string) => checkCanonical(value, quoteNorm, FREQUENCY_PATTERNS, FREQUENCIES)
export const checkRoute = (value: string, quoteNorm: string) => checkCanonical(value, quoteNorm, ROUTE_PATTERNS, ROUTES)

/* ------------------------------ free text ------------------------------ */

const OVERLAP_THRESHOLD = 0.9

export function checkText(value: string, quoteNorm: string, valueNorm: string, allowOverlap: boolean): ValueCheck {
  if (valueNorm.length > 0 && quoteNorm.includes(valueNorm)) return pass(value.trim())
  // Words may be re-ordered or abbreviated slightly (diagnoses, passages), but nearly all must be present.
  if (allowOverlap && wordsOf(valueNorm).length >= 2 && wordOverlap(valueNorm, quoteNorm) >= OVERLAP_THRESHOLD) {
    return pass(value.trim())
  }
  return fail(value)
}

/** Dispatches on the attribute kind. `valueNorm` is the normalised value. */
export function checkValue(
  attribute: AttributeSpec,
  value: string,
  valueNorm: string,
  quoteNorm: string,
  allowOverlap: boolean,
): ValueCheck {
  switch (attribute.kind) {
    case 'number':
      return checkNumber(value, quoteNorm)
    case 'valueOrText':
      return parseNumber(value) !== null || /^\d+(?:\.\d+)?\s*(?:-|to)\s*\d+/.test(value.trim())
        ? checkNumber(value, quoteNorm)
        : checkText(value, quoteNorm, valueNorm, false)
    case 'date':
      return checkDate(value, quoteNorm)
    case 'unit':
      return checkUnit(value, quoteNorm)
    case 'frequency':
      return checkFrequency(value, quoteNorm)
    case 'route':
      return checkRoute(value, quoteNorm)
    case 'enum':
      // A classification chosen by the model, not copied from the text: valid only if it is one of
      // the allowed labels, and always treated as inferred.
      return attribute.values?.includes(value.trim().toLowerCase()) ? pass(value.trim().toLowerCase(), true) : fail(value)
    case 'longtext':
      return checkText(value, quoteNorm, valueNorm, true)
    case 'text':
      return checkText(value, quoteNorm, valueNorm, allowOverlap)
  }
}
