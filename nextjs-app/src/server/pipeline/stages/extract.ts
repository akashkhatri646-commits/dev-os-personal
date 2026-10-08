import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getEnv } from '@/server/config/env'
import type { StageContext, StageOutcome } from '@/server/pipeline/stages'
import { appendAudit } from '@/server/services/audit/auditLog'
import { assertConsentValid } from '@/server/services/consent/ConsentService'
import { catalogFor } from '@/server/services/extraction/fieldCatalog'
import { extractChunk, mergeExtractions, planChunks } from '@/server/services/extraction/extract'
import { groundExtraction, type GroundedField } from '@/server/services/extraction/grounding'
import { extractionResultSchema, type RawExtraction } from '@/server/services/extraction/schema'
import { getLlmClient } from '@/server/services/llm/LLMClient'
import { BUDGET_DEFER_SECONDS, budgetExceeded, recordSpend } from '@/server/services/safety/budget'
import { getActiveExtractionPrompt } from '@/server/services/prompts/promptVersions'
import type { OcrPage } from '@/types/ocr'

const INSERT_BATCH = 100

const pageSchema = z.object({
  page: z.number(),
  text: z.string(),
  confidence: z.number().default(1),
  blocks: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      confidence: z.number().optional(),
      bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    }),
  ),
})

/** Work in progress between worker runs when a long document is read one chunk per job. */
const progressSchema = z.object({
  chunks_done: z.number().int().min(0).default(0),
  raw_chunks: z.array(extractionResultSchema).default([]),
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
})

async function loadPages(recordId: string): Promise<OcrPage[] | null> {
  const { data, error } = await getSupabaseAdmin()
    .from('documents')
    .select('normalized_text')
    .eq('record_id', recordId)
    .limit(1)
    .maybeSingle()
  if (error) throw new AppError('INTERNAL', 'Failed to load the document text.', { cause: error, retryable: true })
  const parsed = z.array(pageSchema).safeParse(data?.normalized_text)
  return parsed.success && parsed.data.length > 0 ? parsed.data : null
}

async function loadPromptSet(recordId: string): Promise<Record<string, unknown>> {
  const { data, error } = await getSupabaseAdmin().from('ingestion_records').select('prompt_set').eq('id', recordId).maybeSingle()
  if (error) throw new AppError('INTERNAL', 'Failed to load the record.', { cause: error, retryable: true })
  const parsed = z.record(z.string(), z.unknown()).safeParse(data?.prompt_set)
  return parsed.success ? parsed.data : {}
}

async function savePromptSet(recordId: string, promptSet: Record<string, unknown>): Promise<void> {
  const { error } = await getSupabaseAdmin().from('ingestion_records').update({ prompt_set: promptSet }).eq('id', recordId)
  if (error) throw new AppError('INTERNAL', 'Failed to save extraction progress.', { cause: error, retryable: true })
}

async function addCost(recordId: string, usd: number): Promise<void> {
  const admin = getSupabaseAdmin()
  const { data } = await admin.from('ingestion_records').select('cost_usd').eq('id', recordId).maybeSingle()
  const current = Number(data?.cost_usd ?? 0)
  await admin.from('ingestion_records').update({ cost_usd: Math.round((current + usd) * 10_000) / 10_000 }).eq('id', recordId)
}

/** Replaces the record's extracted fields. Re-running a stage therefore never duplicates rows. */
async function saveFields(recordId: string, promptVersionId: string, fields: readonly GroundedField[]): Promise<void> {
  const admin = getSupabaseAdmin()
  const { error: deleteError } = await admin.from('extracted_fields').delete().eq('record_id', recordId)
  if (deleteError) throw new AppError('INTERNAL', 'Failed to clear previous fields.', { cause: deleteError, retryable: true })

  const rows = fields.map((field) => ({
    record_id: recordId,
    field_key: field.field_key,
    resource_type: field.resource_type,
    value: field.value,
    found: field.found,
    source_page: field.source_span?.page ?? null,
    source_span: field.source_span,
    // Only values that passed the grounding check are ever stored as found.
    grounded: field.found,
    basis: field.basis,
    model_confidence: field.confidence,
    prompt_version_id: promptVersionId,
  }))
  for (let start = 0; start < rows.length; start += INSERT_BATCH) {
    const { error } = await admin.from('extracted_fields').insert(rows.slice(start, start + INSERT_BATCH))
    if (error) throw new AppError('INTERNAL', 'Failed to save the extracted fields.', { cause: error, retryable: true })
  }
}

/**
 * Component 3: grounded extraction. Reads the normalised text with the language model (one chunk of
 * pages per worker run), then verifies every claimed value against the document and stores only what
 * can be proven, each with its source span. Anything unprovable is stored as "not found".
 *
 * With no model configured the record is held for review (`llm_unavailable`) and can be retried.
 * Runs only after a valid consent check (re-asserted here).
 */
export async function extractStage({ record }: StageContext): Promise<StageOutcome> {
  await assertConsentValid(record.id)

  const env = getEnv()
  const llm = getLlmClient()
  if (!llm || !env.LLM_MODEL_EXTRACTION) return { kind: 'escalate', reason: 'llm_unavailable' }

  const pages = await loadPages(record.id)
  if (!pages) return { kind: 'fail', reason: 'document_not_normalized' }

  const catalog = catalogFor(record.doc_type)
  const chunks = planChunks(pages)
  const promptSet = await loadPromptSet(record.id)
  const saved = progressSchema.parse((promptSet.extraction as unknown) ?? {})
  // Progress only counts while chunks are still being read. A finished or inconsistent record (for
  // example after a manual retry) starts again from the first chunk instead of reusing nothing.
  const resumable = saved.chunks_done < chunks.length && saved.raw_chunks.length === saved.chunks_done
  const progress = resumable ? saved : progressSchema.parse({})
  const prompt = await getActiveExtractionPrompt(env.LLM_MODEL_EXTRACTION)

  const chunkPages = chunks[progress.chunks_done]
  let state = progress
  if (chunkPages) {
    // At the day's spend cap the job waits, untouched, instead of calling the model.
    if (await budgetExceeded()) return { kind: 'defer', seconds: BUDGET_DEFER_SECONDS }
    const result = await extractChunk({
      llm,
      model: env.LLM_MODEL_EXTRACTION,
      system: prompt.template,
      fewShot: prompt.fewShot,
      pages: chunkPages,
      recordId: record.id,
      maxTokens: env.LLM_MAX_OUTPUT_TOKENS,
      timeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
    })
    if (result.costUsd !== null) {
      await addCost(record.id, result.costUsd)
      await recordSpend(result.costUsd)
    }
    state = {
      chunks_done: progress.chunks_done + 1,
      raw_chunks: [...progress.raw_chunks, result.extraction],
      input_tokens: progress.input_tokens + result.usage.inputTokens,
      output_tokens: progress.output_tokens + result.usage.outputTokens,
    }
    if (state.chunks_done < chunks.length) {
      await savePromptSet(record.id, { ...promptSet, extraction: state })
      return { kind: 'repeat' }
    }
  }

  const merged: RawExtraction = mergeExtractions(state.raw_chunks, catalog)
  const report = groundExtraction(merged, pages, catalog)
  await saveFields(record.id, prompt.id, report.fields)

  // Keep the record of how it was extracted, and drop the interim chunk answers.
  await savePromptSet(record.id, {
    ...promptSet,
    extraction: { chunks_done: chunks.length, chunk_count: chunks.length },
    prompt_versions: { ...(promptSet.prompt_versions as object | undefined), extraction: prompt.id },
    model_id: env.LLM_MODEL_EXTRACTION,
    injection_suspected: report.injectionSuspected,
  })

  const foundCount = report.fields.filter((field) => field.found).length
  await appendAudit({
    orgId: record.org_id,
    recordId: record.id,
    actor: { type: 'system' },
    event: 'extraction.completed',
    payload: {
      fields_found: foundCount,
      fields_not_found: report.fields.length - foundCount,
      ungrounded_dropped: report.dropped.filter((entry) => entry.reason !== 'unknown_field').length,
      // Which fields were dropped and why (field keys and reason codes only), to see what grounding rejected.
      dropped: report.dropped.slice(0, 40).map((entry) => ({ field: entry.field_key, reason: entry.reason })),
      prompt_version: prompt.version,
      chunks: chunks.length,
      input_tokens: state.input_tokens,
      output_tokens: state.output_tokens,
    },
  })
  if (report.injectionSuspected) {
    await appendAudit({
      orgId: record.org_id,
      recordId: record.id,
      actor: { type: 'system' },
      event: 'extraction.injection_suspected',
      payload: {},
    })
  }
  return { kind: 'advance' }
}
