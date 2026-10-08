import { AppError } from '@/lib/api/errors'
import type { EntityInstance } from '@/server/services/mapping/entities'
import { buildMappingMessages } from '@/server/services/mapping/prompt'
import { MAPPING_SCHEMA, type MappingChoice } from '@/server/services/mapping/schema'
import { expandQuery, type TermDictionary } from '@/server/services/terminology/dictionary'
import type { TermCandidate, TerminologySearch } from '@/server/services/terminology/search'
import type { CodeSystem, Coding, ResourceType } from '@/types/domain'
import { LlmSchemaError, type LLMClient, type LlmUsage } from '@/types/llm'

/** Fields whose text is turned into a code, the resource they belong to, and the systems to look in. */
interface CodeableSpec {
  entity: string
  attribute: string
  resourceType: ResourceType
  primary: CodeSystem
  /** An optional second code from another system, only added when the primary one was found. */
  secondary?: CodeSystem
}

export const CODEABLE_FIELDS: readonly CodeableSpec[] = [
  { entity: 'diagnosis', attribute: 'text', resourceType: 'Condition', primary: 'snomed', secondary: 'icd10' },
  { entity: 'medication', attribute: 'name', resourceType: 'MedicationRequest', primary: 'snomed' },
  { entity: 'allergy', attribute: 'substance', resourceType: 'AllergyIntolerance', primary: 'snomed' },
  { entity: 'lab', attribute: 'test_name', resourceType: 'Observation', primary: 'loinc' },
  { entity: 'procedure', attribute: 'name', resourceType: 'Procedure', primary: 'snomed' },
]

export const MAX_CANDIDATES_PER_FIELD = 8
const STORED_CANDIDATES = 5
export const MAPPING_BATCH_SIZE = 40
/** Answers below this confidence are treated as "no match". */
export const MIN_MATCH_CONFIDENCE = 0.4

export interface MappingCandidate extends TermCandidate {
  /** Short id the model answers with (`c1`, `c2`, ...), local to one item. */
  id: string
}

export interface MappingItem {
  /** Field key, with `#2` appended for the secondary system. */
  fieldKey: string
  text: string
  context: string
  resourceType: ResourceType
  system: CodeSystem
  /** True for the secondary system, which is only used when the primary one matched. */
  secondary: boolean
  candidates: MappingCandidate[]
}

/** Finds candidate concepts for every codeable field. Fields with no usable candidate are left for "uncoded". */
export async function planMappingItems(
  instances: readonly EntityInstance[],
  search: TerminologySearch,
  dictionary: TermDictionary,
): Promise<{ items: MappingItem[]; withoutCandidates: string[] }> {
  const items: MappingItem[] = []
  const withoutCandidates: string[] = []

  for (const instance of instances) {
    const spec = CODEABLE_FIELDS.find((entry) => entry.entity === instance.entity)
    const field = spec ? instance.attrs[spec.attribute] : undefined
    if (!spec || !field) continue
    const baseKey = `${instance.ref}.${spec.attribute}`
    const text = String(field.value).trim()
    if (text === '') continue

    for (const [system, secondary] of [[spec.primary, false], ...(spec.secondary ? [[spec.secondary, true] as const] : [])] as const) {
      const found = new Map<string, TermCandidate>()
      for (const query of expandQuery(text, dictionary)) {
        for (const candidate of await search.search(query, system, spec.resourceType, MAX_CANDIDATES_PER_FIELD)) {
          const previous = found.get(candidate.code)
          if (!previous || previous.score < candidate.score) found.set(candidate.code, candidate)
        }
      }
      const fieldKey = secondary ? `${baseKey}#2` : baseKey
      const candidates = [...found.values()]
        .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code))
        .slice(0, MAX_CANDIDATES_PER_FIELD)
        .map((candidate, index) => ({ ...candidate, id: `c${index + 1}` }))
      if (candidates.length === 0) {
        withoutCandidates.push(fieldKey)
        continue
      }
      items.push({ fieldKey, text, context: field.span.quote, resourceType: spec.resourceType, system, secondary, candidates })
    }
  }
  return { items, withoutCandidates }
}

export interface MappingOutcome {
  codings: Map<string, Coding>
  /** Fields where the model named something that was not an offered candidate. */
  invalidSelections: Set<string>
  usage: LlmUsage
  costUsd: number | null
}

export interface MapCodesOptions {
  llm: LLMClient
  model: string
  system: string
  recordId: string
  maxTokens: number
  timeoutMs: number
}

async function askModel(options: MapCodesOptions, batch: readonly MappingItem[]) {
  const call = (extra: ReturnType<typeof buildMappingMessages>) =>
    options.llm.complete({
      component: 'mapping',
      model: options.model,
      system: options.system,
      messages: [...buildMappingMessages(batch), ...extra],
      schema: MAPPING_SCHEMA,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
      recordId: options.recordId,
    })
  try {
    return await call([])
  } catch (error) {
    if (!(error instanceof LlmSchemaError)) throw error
    try {
      return await call([{ role: 'user', content: `Your previous answer failed validation: ${error.detail}. Answer again with corrected JSON that matches the schema exactly.` }])
    } catch (second) {
      if (second instanceof LlmSchemaError) throw new AppError('UPSTREAM_ERROR', 'The model did not return a valid mapping.', { retryable: true, cause: second })
      throw second
    }
  }
}

/** Accepts a choice only if it names one of the item's own candidates. Returns null for "no match". */
export function verifyChoice(item: MappingItem, choice: MappingChoice | undefined): { coding: Coding | null; invalid: boolean } {
  if (!choice || choice.candidate_id === null) return { coding: null, invalid: false }
  const picked = item.candidates.find((candidate) => candidate.id === choice.candidate_id)
  if (!picked) return { coding: null, invalid: true }
  if (choice.match_confidence < MIN_MATCH_CONFIDENCE) return { coding: null, invalid: false }
  return {
    coding: {
      field_key: item.fieldKey,
      system: picked.system,
      code: picked.code,
      display: picked.display,
      match_confidence: choice.match_confidence,
      candidates: item.candidates.slice(0, STORED_CANDIDATES).map(({ code, display, score }) => ({ code, display, score })),
    },
    invalid: false,
  }
}

/**
 * Asks the model to pick one candidate for each item (batched), then checks every answer. A secondary
 * code is dropped when its primary code was not found, so a concept is never half-coded.
 */
export async function mapCodes(items: readonly MappingItem[], options: MapCodesOptions): Promise<MappingOutcome> {
  const codings = new Map<string, Coding>()
  const invalidSelections = new Set<string>()
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 }
  let costUsd: number | null = null

  for (let start = 0; start < items.length; start += MAPPING_BATCH_SIZE) {
    const batch = items.slice(start, start + MAPPING_BATCH_SIZE)
    const response = await askModel(options, batch)
    usage.inputTokens += response.usage.inputTokens
    usage.outputTokens += response.usage.outputTokens
    if (response.costUsd !== null) costUsd = (costUsd ?? 0) + response.costUsd

    const choices = new Map(response.output.choices.map((choice) => [choice.field_key, choice]))
    for (const item of batch) {
      const { coding, invalid } = verifyChoice(item, choices.get(item.fieldKey))
      if (invalid) invalidSelections.add(item.fieldKey)
      if (coding) codings.set(item.fieldKey, coding)
    }
  }

  for (const key of [...codings.keys()]) {
    if (key.endsWith('#2') && !codings.has(key.slice(0, -2))) codings.delete(key)
  }
  return { codings, invalidSelections, usage, costUsd }
}
