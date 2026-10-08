import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getEnv } from '@/server/config/env'
import { logger } from '@/server/logger'
import { createOpenAiEmbeddings } from '@/server/services/llm/openaiEmbeddings'
import { providerConfigFromEnv } from '@/server/services/llm/providerConfig'
import type { CodeSystem, ResourceType } from '@/types/domain'

export interface TermCandidate {
  system: CodeSystem
  code: string
  display: string
  /** 0..1, how closely the concept matches the text. */
  score: number
}

/** Finds terminology concepts for a piece of clinical text. */
export interface TerminologySearch {
  search(query: string, system: CodeSystem, resourceType: ResourceType, limit: number): Promise<TermCandidate[]>
  exists(system: CodeSystem, code: string): Promise<boolean>
}

/** Turns text into vectors for semantic search. No client is configured until an embeddings provider is chosen. */
export interface EmbeddingsClient {
  embed(text: string): Promise<number[]>
}

/** Candidates below this score are never offered to the model. */
export const MIN_CANDIDATE_SCORE = 0.4

const STOP_WORDS = new Set(['the', 'and', 'of', 'with', 'for', 'tablet', 'tablets', 'capsule', 'capsules', 'oral', 'mg'])

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word))
}

/**
 * Lexical match score: the share of the query's words that appear in the concept's display text or
 * one of its synonyms (best of those). Deterministic and order-independent.
 */
export function lexicalScore(query: string, display: string, synonyms: readonly string[]): number {
  // The text is exactly the concept's name or one of its synonyms (including short forms such as "AF"): a certain match.
  const normalised = query.trim().toLowerCase()
  if (normalised !== '' && [display, ...synonyms].some((name) => name.trim().toLowerCase() === normalised)) return 1
  const wanted = new Set(tokens(query))
  if (wanted.size === 0) return 0
  let best = 0
  for (const text of [display, ...synonyms]) {
    const have = new Set(tokens(text))
    let hits = 0
    for (const word of wanted) if (have.has(word)) hits += 1
    const precision = have.size === 0 ? 0 : hits / have.size
    // Recall dominates; a long display that merely contains the query words scores a little lower.
    best = Math.max(best, (hits / wanted.size) * 0.8 + precision * 0.2)
  }
  return best
}

interface ConceptRow {
  system: CodeSystem
  code: string
  display: string
  synonyms: string[] | null
  resource_types: string[] | null
}

const escapeLike = (word: string) => word.replace(/[\\%_,()*]/g, '')

export class SupabaseTerminologySearch implements TerminologySearch {
  constructor(private readonly embeddings: EmbeddingsClient | null = null) {}

  async search(query: string, system: CodeSystem, resourceType: ResourceType, limit: number): Promise<TermCandidate[]> {
    if (this.embeddings) {
      try {
        const semantic = await this.semantic(query, system, resourceType, limit)
        if (semantic.length > 0) return semantic
      } catch (error) {
        // An embeddings outage must not stall mapping: fall back to matching on words.
        logger.warn({ err: error }, 'semantic terminology search failed, using word matching')
      }
    }
    return this.lexical(query, system, resourceType, limit)
  }

  private async semantic(query: string, system: CodeSystem, resourceType: ResourceType, limit: number): Promise<TermCandidate[]> {
    const embedding = await (this.embeddings as EmbeddingsClient).embed(query)
    const { data, error } = await getSupabaseAdmin().rpc('search_terminology', {
      p_embedding: embedding as unknown as string,
      p_text: query,
      p_system: system,
      p_resource_type: resourceType,
      p_limit: limit,
    })
    if (error) throw new AppError('INTERNAL', 'Terminology search failed.', { cause: error, retryable: true })
    const rows = (data ?? []) as { system: CodeSystem; code: string; display: string; score: number }[]
    return rows
      .map((row) => ({ system: row.system, code: row.code, display: row.display, score: Number(row.score) }))
      .filter((candidate) => candidate.score >= MIN_CANDIDATE_SCORE)
  }

  private async lexical(query: string, system: CodeSystem, resourceType: ResourceType, limit: number): Promise<TermCandidate[]> {
    const words = tokens(query).map(escapeLike).filter(Boolean)
    // Synonyms are matched as whole entries (the full phrase, or any single word), including short ones such as "mi" or "af".
    const phrases = [...new Set([query.trim().toLowerCase(), ...query.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 2)])]
      .map((phrase) => phrase.replace(/["\\{},]/g, ''))
      .filter(Boolean)
    if (words.length === 0 && phrases.length === 0) return []

    const base = () => getSupabaseAdmin().from('terminology_concepts').select('system, code, display, synonyms, resource_types').eq('system', system).limit(200)
    const [byDisplay, bySynonym] = await Promise.all([
      words.length > 0 ? base().or(words.map((word) => `display.ilike.%${word}%`).join(',')) : Promise.resolve({ data: [], error: null }),
      phrases.length > 0 ? base().or(`synonyms.cs.{${phrases.map((phrase) => `"${phrase}"`).join(',')}}`) : Promise.resolve({ data: [], error: null }),
    ])
    if (byDisplay.error) throw new AppError('INTERNAL', 'Terminology search failed.', { cause: byDisplay.error, retryable: true })
    if (bySynonym.error) throw new AppError('INTERNAL', 'Terminology search failed.', { cause: bySynonym.error, retryable: true })

    const rows = new Map<string, ConceptRow>()
    for (const row of [...((byDisplay.data ?? []) as ConceptRow[]), ...((bySynonym.data ?? []) as ConceptRow[])]) rows.set(row.code, row)
    return [...rows.values()]
      .filter((row) => !row.resource_types || row.resource_types.length === 0 || row.resource_types.includes(resourceType))
      .map((row) => ({ system: row.system, code: row.code, display: row.display, score: lexicalScore(query, row.display, row.synonyms ?? []) }))
      .filter((candidate) => candidate.score >= MIN_CANDIDATE_SCORE)
      .sort((x, y) => y.score - x.score || x.display.localeCompare(y.display))
      .slice(0, limit)
  }

  async exists(system: CodeSystem, code: string): Promise<boolean> {
    const { data, error } = await getSupabaseAdmin().from('terminology_concepts').select('id').eq('system', system).eq('code', code).limit(1)
    if (error) throw new AppError('INTERNAL', 'Terminology lookup failed.', { cause: error, retryable: true })
    return (data ?? []).length > 0
  }
}

/**
 * The embeddings client, or null (word matching only) when no provider or EMBEDDINGS_MODEL is set, or the
 * provider is not fully configured.
 */
export function getEmbeddingsClient(): EmbeddingsClient | null {
  const env = getEnv()
  if (!env.LLM_PROVIDER || !env.EMBEDDINGS_MODEL) return null
  try {
    return createOpenAiEmbeddings({ ...providerConfigFromEnv(env.LLM_PROVIDER), model: env.EMBEDDINGS_MODEL })
  } catch (error) {
    logger.warn({ err: error }, 'embeddings are not configured, using word matching')
    return null
  }
}
