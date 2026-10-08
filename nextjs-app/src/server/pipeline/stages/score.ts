import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import type { StageContext, StageOutcome } from '@/server/pipeline/stages'
import { appendAudit } from '@/server/services/audit/auditLog'
import { assertConsentValid } from '@/server/services/consent/ConsentService'
import { catalogFor } from '@/server/services/extraction/fieldCatalog'
import { scoreRecord, type RecordScore, type ScoreField, type ScoreResource } from '@/server/services/scoring/score'

const INSERT_BATCH = 100

const fieldSchema = z.object({
  field_key: z.string(),
  found: z.boolean(),
  grounded: z.boolean(),
  basis: z.enum(['stated', 'inferred']).nullable(),
  model_confidence: z.coerce.number().nullable(),
  source_span: z.object({ block_ids: z.array(z.string()).optional() }).passthrough().nullable(),
})

const resourceSchema = z.object({
  id: z.string(),
  resource_type: z.string(),
  source_ref: z.string().nullable(),
  codings: z.array(z.object({ field_key: z.string(), match_confidence: z.number() }).passthrough()).default([]),
  flags: z.array(z.string()).default([]),
  validation_status: z.enum(['pass', 'fail', 'pending']),
})

const pagesSchema = z.array(z.object({ blocks: z.array(z.object({ id: z.string(), confidence: z.number().optional() })) }))

function fail(message: string, cause: unknown): never {
  throw new AppError('INTERNAL', message, { cause, retryable: true })
}

async function loadInputs(recordId: string) {
  const admin = getSupabaseAdmin()
  const [fields, resources, documents] = await Promise.all([
    admin.from('extracted_fields').select('field_key, found, grounded, basis, model_confidence, source_span').eq('record_id', recordId),
    admin.from('mapped_resources').select('id, resource_type, source_ref, codings, flags, validation_status').eq('record_id', recordId),
    admin.from('documents').select('normalized_text').eq('record_id', recordId).limit(1).maybeSingle(),
  ])
  if (fields.error) fail('Failed to load the extracted fields.', fields.error)
  if (resources.error) fail('Failed to load the mapped resources.', resources.error)
  if (documents.error) fail('Failed to load the document.', documents.error)

  const blockConfidence = new Map<string, number>()
  const pages = pagesSchema.safeParse(documents.data?.normalized_text)
  if (pages.success) {
    for (const page of pages.data) for (const block of page.blocks) if (block.confidence !== undefined) blockConfidence.set(block.id, block.confidence)
  }
  return {
    fields: z.array(fieldSchema).parse(fields.data ?? []) as ScoreField[],
    resources: z.array(resourceSchema).parse(resources.data ?? []) as unknown as ScoreResource[],
    blockConfidence,
  }
}

/** Replaces the record's scores, so re-running the stage never duplicates rows. */
async function saveScores(recordId: string, result: RecordScore): Promise<void> {
  const admin = getSupabaseAdmin()
  const { error: deleteError } = await admin.from('field_scores').delete().eq('record_id', recordId)
  if (deleteError) fail('Failed to clear previous scores.', deleteError)

  const rows = [
    ...result.fields.map((field) => ({
      record_id: recordId,
      scope: 'field',
      field_key: field.fieldKey,
      resource_id: field.resourceId,
      extraction_conf: field.extraction,
      mapping_conf: field.mapping,
      validation_completeness: field.validation,
      score: field.score,
      components: { E: field.extraction, M: field.mapping, V: field.validation, ocr_factor: field.ocrFactor, caps_applied: field.capsApplied, adjust: 0, required: field.required },
      reasoning: field.reasoning,
    })),
    ...result.resources.map((resource) => ({
      record_id: recordId,
      scope: 'resource',
      field_key: null,
      resource_id: resource.resourceId,
      score: resource.score,
      components: { min_required: resource.minRequired, mean: resource.mean, calibrated: false },
      reasoning: `${resource.resourceType}: 0.7 × min required ${resource.minRequired.toFixed(2)} + 0.3 × mean ${resource.mean.toFixed(2)} → ${resource.score.toFixed(2)}`,
    })),
    {
      record_id: recordId,
      scope: 'record',
      field_key: null,
      resource_id: null,
      score: result.aggregate,
      components: { missing_required: result.missingRequired, calibrated: false, calibrator_version: null, self_assessment: 'not_run' },
      reasoning: `Record aggregate ${result.aggregate.toFixed(2)} = lowest resource score${result.missingRequired.length > 0 ? `; ${result.missingRequired.length} required field(s) missing` : ''}`,
    },
  ]
  for (let start = 0; start < rows.length; start += INSERT_BATCH) {
    const { error } = await admin.from('field_scores').insert(rows.slice(start, start + INSERT_BATCH))
    if (error) fail('Failed to save the scores.', error)
  }
}

/**
 * Component 5: confidence scoring. Every number comes from stored facts by fixed rules (extraction
 * confidence after grounding, mapping match, validation, then caps for inferred values, poor scans
 * and uncertain values); nothing a model says can raise a score. Writes field, resource and record
 * scores with a plain-text reasoning for each.
 */
export async function scoreStage({ record }: StageContext): Promise<StageOutcome> {
  await assertConsentValid(record.id)
  const inputs = await loadInputs(record.id)
  const result = scoreRecord({ ...inputs, catalog: catalogFor(record.doc_type) })
  await saveScores(record.id, result)

  await appendAudit({
    orgId: record.org_id,
    recordId: record.id,
    actor: { type: 'system' },
    event: 'scoring.completed',
    payload: {
      aggregate: result.aggregate,
      resources: result.resources.length,
      fields: result.fields.length,
      missing_required: result.missingRequired.length,
    },
  })
  return { kind: 'advance' }
}
