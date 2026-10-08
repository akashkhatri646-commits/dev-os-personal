import { AppError } from '@/lib/api/errors'
import { buildTarget, classifyFailure, failureToError, postJson, type Fetch, type ProviderConfig } from '@/server/services/llm/openaiHttp'
import type { EmbeddingsClient } from '@/server/services/terminology/search'

/** The width of `terminology_concepts.embedding` and `knowledge_docs.embedding` (`vector(1024)`). */
export const EMBEDDING_DIMENSIONS = 1024
const EMBEDDINGS_TIMEOUT_MS = 15_000
/** Long inputs are cut: terms and short phrases are what gets embedded. */
const MAX_INPUT_CHARS = 2000

export interface EmbeddingsConfig extends ProviderConfig {
  /** Embedding model id (Azure: deployment name). Must accept the `dimensions` parameter. */
  model: string
  fetch?: Fetch
}

/**
 * Embeds short clinical phrases at 1024 dimensions to match the database column. A failure throws a
 * retryable upstream error for outages; a wrong-sized or missing vector is a final error, so a bad
 * model choice shows up at once instead of silently breaking search.
 */
export function createOpenAiEmbeddings(config: EmbeddingsConfig): EmbeddingsClient {
  const fetchImpl: Fetch = config.fetch ?? ((url, init) => fetch(url, init))
  return {
    async embed(text: string): Promise<number[]> {
      const target = buildTarget(config, 'embeddings', config.model)
      const response = await postJson(
        fetchImpl,
        target.url,
        target.headers,
        { ...(target.modelInBody ? { model: config.model } : {}), input: text.slice(0, MAX_INPUT_CHARS), dimensions: EMBEDDING_DIMENSIONS, encoding_format: 'float' },
        EMBEDDINGS_TIMEOUT_MS,
      )
      if (response.status < 200 || response.status >= 300) throw failureToError(classifyFailure(response.status, response.body, response.headers), response.status)

      const vector = (response.body as { data?: { embedding?: unknown }[] } | null)?.data?.[0]?.embedding
      if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS || !vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
        throw new AppError('INTERNAL', `The embedding model did not return ${EMBEDDING_DIMENSIONS} numbers. Check EMBEDDINGS_MODEL supports the dimensions parameter.`, {
          retryable: false,
          reason: 'EMBEDDINGS_SHAPE',
        })
      }
      return vector as number[]
    },
  }
}
