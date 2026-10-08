import { AppError } from '@/lib/api/errors'
import {
  formatFieldKey,
  parseFieldKey,
  type EntitySpec,
} from '@/server/services/extraction/fieldCatalog'
import { groundExtraction, type GroundingReport } from '@/server/services/extraction/grounding'
import { buildExtractionMessages, type FewShotExample } from '@/server/services/extraction/prompt'
import { EXTRACTION_SCHEMA, type RawExtraction, type RawExtractionField } from '@/server/services/extraction/schema'
import { normalizeText } from '@/server/services/extraction/textMatch'
import { LlmSchemaError, type LLMClient, type LlmUsage } from '@/types/llm'
import type { OcrPage } from '@/types/ocr'

/** Pages per model call, with this many pages repeated at each boundary so nothing is cut in half. */
export const MAX_PAGES_PER_CHUNK = 8
export const CHUNK_OVERLAP_PAGES = 1

/** Splits a long document into overlapping page groups; a short one stays whole. */
export function planChunks(pages: readonly OcrPage[], maxPages = MAX_PAGES_PER_CHUNK, overlap = CHUNK_OVERLAP_PAGES): OcrPage[][] {
  if (pages.length <= maxPages) return [[...pages]]
  const step = Math.max(1, maxPages - overlap)
  const chunks: OcrPage[][] = []
  for (let start = 0; start < pages.length; start += step) {
    chunks.push(pages.slice(start, start + maxPages))
    if (start + maxPages >= pages.length) break
  }
  return chunks
}

export interface ChunkResult {
  extraction: RawExtraction
  usage: LlmUsage
  costUsd: number | null
}

export interface ExtractChunkOptions {
  llm: LLMClient
  model: string
  system: string
  fewShot: readonly FewShotExample[]
  pages: readonly OcrPage[]
  recordId: string
  maxTokens: number
  timeoutMs: number
}

const sumUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
})
const sumCost = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0))

/**
 * One extraction call. A reply that does not match the schema gets exactly one repair attempt that
 * quotes the validation problems; a second failure is a retryable upstream error for the worker.
 */
export async function extractChunk(options: ExtractChunkOptions): Promise<ChunkResult> {
  const messages = buildExtractionMessages(options.pages, options.fewShot)
  const call = (extra: typeof messages) =>
    options.llm.complete({
      component: 'extraction',
      model: options.model,
      system: options.system,
      messages: [...messages, ...extra],
      schema: EXTRACTION_SCHEMA,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
      recordId: options.recordId,
    })

  try {
    const first = await call([])
    return { extraction: first.output, usage: first.usage, costUsd: first.costUsd }
  } catch (error) {
    if (!(error instanceof LlmSchemaError)) throw error
    try {
      const repaired = await call([
        {
          role: 'user',
          content: `Your previous answer failed validation: ${error.detail}. Answer again with corrected JSON that matches the schema exactly.`,
        },
      ])
      return { extraction: repaired.output, usage: repaired.usage, costUsd: repaired.costUsd }
    } catch (second) {
      if (second instanceof LlmSchemaError) {
        throw new AppError('UPSTREAM_ERROR', 'The model did not return a valid answer.', { retryable: true, cause: second })
      }
      throw second
    }
  }
}

interface Instance {
  entity: EntitySpec
  fields: RawExtractionField[]
}

const foundCount = (instance: Instance) => instance.fields.filter((field) => field.found).length

/**
 * Combines the answers for overlapping chunks. Each chunk numbers its own entities from 0, so
 * instances are renumbered chunk by chunk first; then an instance repeated in an overlap page (same
 * entity and same name) is kept once, preferring the one with more fields found.
 */
export function mergeExtractions(results: readonly RawExtraction[], catalog: readonly EntitySpec[]): RawExtraction {
  const merged = new Map<string, Instance>()
  const passthrough: RawExtractionField[] = []
  const nextIndex = new Map<string, number>()
  const notes: string[] = []

  for (const result of results) {
    if (result.document_notes) notes.push(result.document_notes)
    const chunkInstances = new Map<string, Instance & { originalIndex: number | null }>()

    for (const field of result.fields) {
      const parsed = parseFieldKey(field.field_key)
      const entity = catalog.find((candidate) => candidate.entity === parsed?.entity)
      if (!parsed || !entity) {
        passthrough.push(field)
        continue
      }
      const key = `${entity.entity}#${parsed.index ?? ''}`
      const instance = chunkInstances.get(key) ?? { entity, fields: [], originalIndex: parsed.index }
      instance.fields.push(field)
      chunkInstances.set(key, instance)
    }

    for (const instance of chunkInstances.values()) {
      const primary = instance.fields.find((field) => field.found && parseFieldKey(field.field_key)?.attribute === instance.entity.primary)
      const identity = primary?.value ? `${instance.entity.entity}|${normalizeText(primary.value)}` : null

      const existing = identity ? merged.get(identity) : undefined
      if (existing) {
        if (foundCount(instance) > foundCount(existing)) merged.set(identity as string, instance)
        continue
      }
      const slot = identity ?? `${instance.entity.entity}|unnamed|${merged.size}`
      merged.set(slot, instance)
    }
  }

  const fields: RawExtractionField[] = [...passthrough]
  for (const instance of merged.values()) {
    const index = instance.entity.repeating ? (nextIndex.get(instance.entity.entity) ?? 0) : null
    if (index !== null) nextIndex.set(instance.entity.entity, index + 1)
    for (const field of instance.fields) {
      const parsed = parseFieldKey(field.field_key)
      if (parsed) fields.push({ ...field, field_key: formatFieldKey(parsed.entity, index, parsed.attribute) })
    }
  }
  return { fields, document_notes: notes.join(' ').slice(0, 500) }
}

export interface ExtractionRun {
  report: GroundingReport
  usage: LlmUsage
  costUsd: number | null
  chunks: number
}

/**
 * Extraction for a whole document in one go: chunk, call the model for each chunk, merge, then
 * ground. The worker stage does the same work one chunk per job; this is the same logic for
 * evaluations and tests.
 */
export async function runExtraction(
  options: Omit<ExtractChunkOptions, 'pages'> & { pages: readonly OcrPage[]; catalog: readonly EntitySpec[] },
): Promise<ExtractionRun> {
  const chunks = planChunks(options.pages)
  const results: RawExtraction[] = []
  let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 }
  let costUsd: number | null = null
  for (const pages of chunks) {
    const result = await extractChunk({ ...options, pages })
    results.push(result.extraction)
    usage = sumUsage(usage, result.usage)
    costUsd = sumCost(costUsd, result.costUsd)
  }
  const merged = mergeExtractions(results, options.catalog)
  return { report: groundExtraction(merged, options.pages, options.catalog), usage, costUsd, chunks: chunks.length }
}
