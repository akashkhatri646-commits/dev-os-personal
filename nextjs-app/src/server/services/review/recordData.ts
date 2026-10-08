import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import type { RecordRow } from '@/server/pipeline/orchestrator'
import { catalogFor } from '@/server/services/extraction/fieldCatalog'
import {
  buildWorkspaceResources,
  type WorkspaceFieldRow,
  type WorkspaceResourceRow,
  type WorkspaceScoreRow,
} from '@/server/services/review/workspace'
import type { WorkspaceResource } from '@/types/review'

function fail(message: string, cause: unknown): never {
  throw new AppError('INTERNAL', message, { cause })
}

/** Everything stored about a record that the review workspace and the record page show. */
const codingSchema = z.object({
  field_key: z.string(),
  system: z.enum(['snomed', 'loinc', 'icd10']),
  code: z.string(),
  display: z.string(),
  match_confidence: z.coerce.number(),
  candidates: z.array(z.object({ code: z.string(), display: z.string(), score: z.coerce.number() })).default([]),
})

const resourceRowSchema = z.object({
  id: z.string(),
  resource_type: z.string(),
  source_ref: z.string().nullable(),
  codings: z.array(codingSchema).default([]),
  flags: z.array(z.string()).default([]),
  validation_status: z.enum(['pass', 'fail', 'pending']),
  validation_issues: z.array(z.object({ severity: z.enum(['error', 'warning']), path: z.string(), message: z.string(), ruleId: z.string() })).default([]),
})

const fieldRowSchema = z.object({
  field_key: z.string(),
  found: z.boolean(),
  value: z.unknown(),
  source_span: z.record(z.string(), z.unknown()).nullable(),
  basis: z.enum(['stated', 'inferred']).nullable(),
  model_confidence: z.coerce.number().nullable(),
})

const scoreRowSchema = z.object({
  scope: z.enum(['field', 'resource', 'record']),
  field_key: z.string().nullable(),
  resource_id: z.string().nullable(),
  score: z.coerce.number(),
  components: z.record(z.string(), z.unknown()).nullable(),
})

const decisionRowSchema = z.object({
  aggregate_score: z.coerce.number(),
  escalation_reasons: z.array(z.string()),
  reasoning_trace: z.string(),
  thresholds_applied: z.record(z.string(), z.unknown()),
})

export async function loadWorkspaceData(record: RecordRow) {
  const admin = getSupabaseAdmin()
  const [source, document, decision, resources, fields, scores, consent] = await Promise.all([
    admin.from('provider_sources').select('id, name').eq('id', record.source_id).maybeSingle(),
    admin.from('documents').select('storage_path, mime_type, ocr_confidence, normalized_text').eq('record_id', record.id).limit(1).maybeSingle(),
    admin.from('routing_decisions').select('aggregate_score, escalation_reasons, reasoning_trace, thresholds_applied').eq('record_id', record.id).maybeSingle(),
    admin.from('mapped_resources').select('id, resource_type, source_ref, codings, flags, validation_status, validation_issues').eq('record_id', record.id),
    admin.from('extracted_fields').select('field_key, found, value, source_span, basis, model_confidence').eq('record_id', record.id),
    admin.from('field_scores').select('scope, field_key, resource_id, score, components').eq('record_id', record.id),
    admin.from('consent_checks').select('result, checked_at').eq('record_id', record.id).maybeSingle(),
  ])
  for (const result of [source, document, decision, resources, fields, scores, consent]) {
    if (result.error) fail('Failed to load the review data.', result.error)
  }
  return {
    source: source.data as { id: string; name: string } | null,
    document: document.data,
    decision: decision.data ? decisionRowSchema.parse(decision.data) : null,
    resources: z.array(resourceRowSchema).parse(resources.data ?? []),
    fields: z.array(fieldRowSchema).parse(fields.data ?? []),
    scores: z.array(scoreRowSchema).parse(scores.data ?? []),
    consent: consent.data as { result: string; checked_at: string } | null,
  }
}

export type WorkspaceData = Awaited<ReturnType<typeof loadWorkspaceData>>

export function resourcesOf(record: RecordRow, data: WorkspaceData): WorkspaceResource[] {
  const thresholds = Object.fromEntries(
    Object.entries(data.decision?.thresholds_applied ?? {})
      .filter(([key, value]) => key !== '_checksum' && typeof value === 'object' && value !== null)
      .map(([key, value]) => [key, { threshold: Number((value as { threshold: unknown }).threshold) }]),
  )
  return buildWorkspaceResources({
    resources: data.resources as WorkspaceResourceRow[],
    fields: data.fields as WorkspaceFieldRow[],
    scores: data.scores as WorkspaceScoreRow[],
    thresholds,
    catalog: catalogFor(record.doc_type),
  })
}

