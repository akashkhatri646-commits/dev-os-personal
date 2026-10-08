import {
  resolveField,
  formatFieldKey,
  type EntitySpec,
  type ResolvedField,
} from '@/server/services/extraction/fieldCatalog'
import type { RawExtraction, RawExtractionField } from '@/server/services/extraction/schema'
import { approximateFind, normalizeText, normalizeWithMap, wordsOf } from '@/server/services/extraction/textMatch'
import { checkValue } from '@/server/services/extraction/valueChecks'
import type { ResourceType, SourceSpan } from '@/types/domain'
import type { OcrPage } from '@/types/ocr'

/**
 * The grounding check (docs/specs/06 §7): the deterministic guard against hallucinated values.
 * A value the model claims to have found is kept only if (1) the quote it cites really occurs in the
 * cited blocks of the document, (2) the value is supported by that text, and (3) the cited line
 * belongs to the same entity (the dose is on the drug's own line). Anything else is converted to
 * "not found": an ungrounded value is never stored and can never reach a reviewer as extracted data.
 */

export type DropReason =
  | 'unknown_field'
  | 'page_missing'
  | 'block_missing'
  | 'quote_not_found'
  | 'value_unsupported'
  | 'enum_invalid'
  | 'anchor_missing'
  | 'entity_mismatch'
  | 'injection_suspected'

export interface GroundedField {
  field_key: string
  resource_type: ResourceType
  /** Typed per the catalogue (numbers are numbers). Null when not found. */
  value: string | number | null
  found: boolean
  source_span: SourceSpan | null
  basis: 'stated' | 'inferred' | null
  /** The model's own confidence, 0 when not found. */
  confidence: number
}

export interface GroundingReport {
  fields: GroundedField[]
  /** Claims that failed verification, by field and reason only. Values are never recorded. */
  dropped: { field_key: string; reason: DropReason }[]
  injectionSuspected: boolean
}

/** Minimum similarity for a quote that differs from the document only by OCR noise. */
const FUZZY_QUOTE_SIMILARITY = 0.95
/** Quotes shorter than this must match exactly: a fuzzy match on a few characters proves nothing. */
const MIN_FUZZY_LENGTH = 8
const MIN_ANCHOR_WORD = 3

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts?|rules)/i,
  /disregard (all |any |the )?(previous|prior|above|earlier)/i,
  /system prompt/i,
  /you (must|should) (now )?(set|output|return|change|ignore|disregard|always)/i,
  /\bact as (a|an|the)\b/i,
  /new instructions?:/i,
]

/** Text that tries to give the model orders (prompt injection) rather than describe a patient. */
export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text))
}

interface Located {
  charStart: number
  charEnd: number
  quote: string
  bbox?: [number, number, number, number]
  firstBlock: number
  lastBlock: number
}

/** Where each block starts inside the page text (blocks are joined by line breaks). */
function blockOffsets(page: OcrPage): number[] {
  const offsets: number[] = []
  let cursor = 0
  for (const block of page.blocks) {
    const found = page.text.indexOf(block.text, cursor)
    const start = found === -1 ? cursor : found
    offsets.push(start)
    cursor = start + block.text.length
  }
  return offsets
}

function unionBox(page: OcrPage, first: number, last: number): [number, number, number, number] | undefined {
  const boxes = page.blocks.slice(first, last + 1).flatMap((block) => (block.bbox ? [block.bbox] : []))
  if (boxes.length === 0) return undefined
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ]
}

/**
 * Finds the quote inside the cited blocks (exact, or within OCR noise) and reports its true position
 * in the page text. The stored quote is the document's own text, never the model's wording.
 */
export function locateQuote(page: OcrPage, blockIds: readonly string[], quote: string): Located | DropReason {
  const indexes = [...new Set(blockIds.map((id) => page.blocks.findIndex((block) => block.id === id)))]
  if (indexes.some((index) => index < 0)) return 'block_missing'
  indexes.sort((a, b) => a - b)

  const offsets = blockOffsets(page)
  let haystack = ''
  const segments: { blockIndex: number; start: number; length: number; map: number[] }[] = []
  for (const blockIndex of indexes) {
    const { norm, map } = normalizeWithMap(page.blocks[blockIndex]?.text ?? '')
    if (haystack.length > 0) haystack += ' '
    segments.push({ blockIndex, start: haystack.length, length: norm.length, map })
    haystack += norm
  }

  const needle = normalizeText(quote)
  if (needle.length === 0) return 'quote_not_found'

  let start = haystack.indexOf(needle)
  let end = start + needle.length
  if (start < 0) {
    if (needle.length < MIN_FUZZY_LENGTH) return 'quote_not_found'
    const approx = approximateFind(haystack, needle)
    if (1 - approx.distance / needle.length < FUZZY_QUOTE_SIMILARITY || approx.end <= approx.start) return 'quote_not_found'
    start = approx.start
    end = approx.end
  }

  const locate = (position: number, atEnd: boolean): { blockIndex: number; offset: number } | null => {
    let segment = segments.find((candidate) => position >= candidate.start && position < candidate.start + candidate.length)
    let relative = segment ? position - segment.start : 0
    if (!segment) {
      // The position sits on the space between two blocks: step to the nearest real character.
      segment = atEnd
        ? [...segments].reverse().find((candidate) => candidate.start + candidate.length <= position)
        : segments.find((candidate) => candidate.start > position)
      if (!segment) return null
      relative = atEnd ? segment.length - 1 : 0
    }
    const original = segment.map[Math.min(relative, segment.map.length - 1)]
    const base = offsets[segment.blockIndex]
    if (original === undefined || base === undefined) return null
    return { blockIndex: segment.blockIndex, offset: base + original }
  }

  const from = locate(start, false)
  const to = locate(end - 1, true)
  if (!from || !to) return 'quote_not_found'
  const charStart = from.offset
  const charEnd = to.offset + 1
  if (charEnd <= charStart) return 'quote_not_found'

  return {
    charStart,
    charEnd,
    quote: page.text.slice(charStart, charEnd),
    bbox: unionBox(page, from.blockIndex, to.blockIndex),
    firstBlock: from.blockIndex,
    lastBlock: to.blockIndex,
  }
}

interface Candidate {
  key: string
  resolved: ResolvedField
  raw: RawExtractionField
  status: 'found' | 'notfound' | 'dropped'
  value: string | number | null
  span: SourceSpan | null
  basis: 'stated' | 'inferred' | null
  located: Located | null
  page: OcrPage | null
  reason?: DropReason
}

const allowsWordOverlap = (resolved: ResolvedField): boolean =>
  resolved.attribute.kind === 'longtext' || (resolved.entity.entity === 'diagnosis' && resolved.attribute.name === 'text')

function groundOne(raw: RawExtractionField, resolved: ResolvedField, pages: readonly OcrPage[]): Candidate {
  const base: Candidate = {
    key: raw.field_key,
    resolved,
    raw,
    status: 'dropped',
    value: null,
    span: null,
    basis: null,
    located: null,
    page: null,
  }
  if (!raw.found) return { ...base, status: 'notfound' }
  if (!raw.source || raw.value === null) return { ...base, reason: 'quote_not_found' }

  const page = pages.find((candidate) => candidate.page === raw.source?.page)
  if (!page) return { ...base, reason: 'page_missing' }
  if (looksLikeInjection(raw.source.quote)) return { ...base, reason: 'injection_suspected' }

  const located = locateQuote(page, raw.source.block_ids, raw.source.quote)
  if (typeof located === 'string') return { ...base, page, reason: located }
  if (looksLikeInjection(located.quote)) return { ...base, page, reason: 'injection_suspected' }

  const check = checkValue(
    resolved.attribute,
    raw.value,
    normalizeText(raw.value),
    normalizeText(located.quote),
    allowsWordOverlap(resolved),
  )
  if (!check.ok) return { ...base, page, located, reason: resolved.attribute.kind === 'enum' ? 'enum_invalid' : 'value_unsupported' }

  const span: SourceSpan = {
    page: page.page,
    block_ids: raw.source.block_ids,
    quote: located.quote,
    char_start: located.charStart,
    char_end: located.charEnd,
    ...(located.bbox ? { bbox: located.bbox } : {}),
  }
  return {
    ...base,
    status: 'found',
    value: check.value,
    span,
    // A value the checker had to interpret (ranges, ambiguous dates, classifications) is never "stated".
    basis: check.forceInferred ? 'inferred' : (raw.basis ?? 'stated'),
    located,
    page,
  }
}

const entityKey = (candidate: Candidate) => `${candidate.resolved.entity.entity}#${candidate.resolved.parsed.index ?? ''}`

/**
 * Entity coherence: an attribute such as a dose must be cited from the same place as the entity it
 * belongs to. The cited line (or the line either side of it) has to mention the entity's anchor
 * (the drug name, the lab test, the allergen); otherwise the value was lifted from somewhere else.
 */
function coherenceFailure(candidate: Candidate, anchors: Map<string, Candidate>): DropReason | null {
  const { entity, attribute } = candidate.resolved
  if (!entity.anchor || attribute.name === entity.anchor || candidate.status !== 'found') return null

  const anchor = anchors.get(entityKey(candidate))
  if (!anchor || anchor.status !== 'found' || typeof anchor.value !== 'string') return 'anchor_missing'
  const { page, located } = candidate
  if (!page || !located) return 'entity_mismatch'

  const from = Math.max(0, located.firstBlock - 1)
  const to = Math.min(page.blocks.length - 1, located.lastBlock + 1)
  const surrounding = normalizeText(page.blocks.slice(from, to + 1).map((block) => block.text).join(' '))

  const anchorNorm = normalizeText(anchor.value)
  const words = wordsOf(anchorNorm).filter((word) => word.length >= MIN_ANCHOR_WORD)
  const mentioned = words.length > 0 ? words.some((word) => surrounding.includes(word)) : surrounding.includes(anchorNorm)
  return mentioned ? null : 'entity_mismatch'
}

interface Instance {
  entity: EntitySpec
  originalIndex: number | null
  candidates: Candidate[]
}

function position(instance: Instance): number {
  const starts = instance.candidates.flatMap((candidate) =>
    candidate.status === 'found' && candidate.span ? [candidate.span.page * 1_000_000 + candidate.span.char_start] : [],
  )
  return starts.length > 0 ? Math.min(...starts) : Number.POSITIVE_INFINITY
}

/**
 * Verifies every field the model claims to have found against the document, drops what cannot be
 * proven, numbers repeating entities in document order, and adds explicit "not found" rows for the
 * required attributes of any entity that was found.
 */
export function groundExtraction(
  extraction: RawExtraction,
  pages: readonly OcrPage[],
  catalog: readonly EntitySpec[],
): GroundingReport {
  const dropped: GroundingReport['dropped'] = []
  let injectionSuspected = false

  // One answer per field: when the model repeats a key, keep the more confident, found one.
  const byKey = new Map<string, RawExtractionField>()
  for (const field of extraction.fields) {
    const existing = byKey.get(field.field_key)
    const better =
      !existing ||
      (field.found && !existing.found) ||
      (field.found === existing.found && field.confidence > existing.confidence)
    if (better) byKey.set(field.field_key, field)
  }

  const candidates: Candidate[] = []
  for (const raw of byKey.values()) {
    const resolved = resolveField(catalog, raw.field_key)
    if (!resolved) {
      dropped.push({ field_key: raw.field_key, reason: 'unknown_field' })
      continue
    }
    candidates.push(groundOne(raw, resolved, pages))
  }

  // Entity coherence needs the grounded anchors (drug names, test names, allergens).
  const anchors = new Map<string, Candidate>()
  for (const candidate of candidates) {
    if (candidate.resolved.entity.anchor === candidate.resolved.attribute.name) anchors.set(entityKey(candidate), candidate)
  }
  const verified = candidates.map((candidate) => {
    const failure = coherenceFailure(candidate, anchors)
    return failure ? { ...candidate, status: 'dropped' as const, value: null, span: null, basis: null, reason: failure } : candidate
  })

  for (const candidate of verified) {
    if (candidate.status === 'dropped' && candidate.reason) {
      dropped.push({ field_key: candidate.key, reason: candidate.reason })
      if (candidate.reason === 'injection_suspected') injectionSuspected = true
    }
  }

  // Group claims into entity instances; an instance with nothing proven disappears entirely.
  const instances = new Map<string, Instance>()
  for (const candidate of verified) {
    const key = entityKey(candidate)
    const instance = instances.get(key) ?? {
      entity: candidate.resolved.entity,
      originalIndex: candidate.resolved.parsed.index,
      candidates: [],
    }
    instance.candidates.push(candidate)
    instances.set(key, instance)
  }
  const proven = [...instances.values()].filter((instance) => instance.candidates.some((candidate) => candidate.status === 'found'))

  const fields: GroundedField[] = []
  for (const entity of catalog) {
    const own = proven
      .filter((instance) => instance.entity.entity === entity.entity)
      .sort((a, b) => position(a) - position(b) || (a.originalIndex ?? 0) - (b.originalIndex ?? 0))

    own.forEach((instance, order) => {
      const index = entity.repeating ? order : null
      for (const attribute of entity.attributes) {
        const candidate = instance.candidates.find((entry) => entry.resolved.attribute.name === attribute.name)
        const key = formatFieldKey(entity.entity, index, attribute.name)
        if (candidate?.status === 'found' && candidate.span) {
          fields.push({
            field_key: key,
            resource_type: entity.resourceType,
            value: candidate.value,
            found: true,
            source_span: candidate.span,
            basis: candidate.basis,
            confidence: candidate.raw.confidence,
          })
        } else if (candidate || attribute.required) {
          fields.push(notFound(key, entity.resourceType))
        }
      }
    })
  }
  return { fields, dropped, injectionSuspected }
}

function notFound(fieldKey: string, resourceType: ResourceType): GroundedField {
  return { field_key: fieldKey, resource_type: resourceType, value: null, found: false, source_span: null, basis: null, confidence: 0 }
}

