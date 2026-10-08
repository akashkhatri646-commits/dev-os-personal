import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { resolveThreshold } from '@/lib/sources/rules'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getRuntimeConfig } from '@/server/config/constants'
import type { StageContext, StageOutcome } from '@/server/pipeline/stages'
import { appendAudit } from '@/server/services/audit/auditLog'
import { assertConsentValid } from '@/server/services/consent/ConsentService'
import { decideRoute, thresholdsChecksum } from '@/server/services/routing/decide'
import { loadActiveThresholds } from '@/server/services/sources/sourceService'

const resourceSchema = z.object({
  id: z.string(),
  resource_type: z.string(),
  flags: z.array(z.string()).default([]),
  validation_status: z.enum(['pass', 'fail', 'pending']),
})

const scoreSchema = z.object({
  scope: z.enum(['field', 'resource', 'record']),
  resource_id: z.string().nullable(),
  score: z.coerce.number(),
  components: z.record(z.string(), z.unknown()).nullable(),
})

function fail(message: string, cause: unknown): never {
  throw new AppError('INTERNAL', message, { cause, retryable: true })
}

/**
 * Component 6: the routing gate. A fixed rule, no model: auto-commit only when OCR, validation,
 * grounding, coding, every resource's threshold and the source switch are all clear. The decision,
 * the thresholds it used and a plain-text trace are stored for every record, then the record either
 * goes on to commit or into the review queue.
 */
export async function routeStage({ record }: StageContext): Promise<StageOutcome> {
  await assertConsentValid(record.id)
  const admin = getSupabaseAdmin()

  const [source, document, resources, scores, ungrounded, current] = await Promise.all([
    admin.from('provider_sources').select('auto_commit_enabled, holdback_pct').eq('id', record.source_id).maybeSingle(),
    admin.from('documents').select('ocr_confidence').eq('record_id', record.id).limit(1).maybeSingle(),
    admin.from('mapped_resources').select('id, resource_type, flags, validation_status').eq('record_id', record.id),
    admin.from('field_scores').select('scope, resource_id, score, components').eq('record_id', record.id),
    admin.from('extracted_fields').select('id', { count: 'exact', head: true }).eq('record_id', record.id).eq('found', true).eq('grounded', false),
    admin.from('ingestion_records').select('prompt_set').eq('id', record.id).maybeSingle(),
  ])
  if (source.error) fail('Failed to load the source.', source.error)
  if (document.error) fail('Failed to load the document.', document.error)
  if (resources.error) fail('Failed to load the mapped resources.', resources.error)
  if (scores.error) fail('Failed to load the scores.', scores.error)
  if (ungrounded.error) fail('Failed to check the extracted fields.', ungrounded.error)
  if (current.error) fail('Failed to load the record.', current.error)
  if (!source.data) return { kind: 'fail', reason: 'source_missing' }

  const scoreRows = z.array(scoreSchema).parse(scores.data ?? [])
  const resourceScores = new Map(scoreRows.filter((row) => row.scope === 'resource').map((row) => [row.resource_id, row.score]))
  const recordRow = scoreRows.find((row) => row.scope === 'record')
  const missingRequired = z.array(z.string()).catch([]).parse(recordRow?.components?.missing_required)
  const mapped = z.array(resourceSchema).parse(resources.data ?? [])
  const thresholds = await loadActiveThresholds(record.source_id)
  const config = getRuntimeConfig()
  const promptSet = z.record(z.string(), z.unknown()).catch({}).parse(current.data?.prompt_set)

  const result = decideRoute({
    ocrConfidence: document.data?.ocr_confidence === null || document.data?.ocr_confidence === undefined ? null : Number(document.data.ocr_confidence),
    ocrFloor: config.ocrConfidenceFloor,
    resources: mapped.map((resource) => ({
      id: resource.id,
      type: resource.resource_type,
      flags: resource.flags,
      validation: resource.validation_status,
      score: resourceScores.get(resource.id) ?? 0,
    })),
    ungroundedFound: (ungrounded.count ?? 0) > 0,
    missingRequired,
    aggregate: recordRow?.score ?? 0,
    thresholdFor: (type) => resolveThreshold(thresholds, type),
    sourceAutoCommit: source.data.auto_commit_enabled === true,
    systemAutoCommit: config.systemAutoCommitEnabled,
    injectionSuspected: promptSet.injection_suspected === true,
    holdbackPct: Number(source.data.holdback_pct ?? 0),
  })

  const { error: saveError } = await admin.from('routing_decisions').upsert(
    {
      record_id: record.id,
      aggregate_score: recordRow?.score ?? 0,
      thresholds_applied: { ...result.thresholdsApplied, _checksum: thresholdsChecksum(result.thresholdsApplied) },
      validation_result: result.validation,
      decision: result.decision,
      escalation_reasons: result.reasons,
      reasoning_trace: result.trace,
      rule_version: result.ruleVersion,
    },
    { onConflict: 'record_id' },
  )
  if (saveError) fail('Failed to save the routing decision.', saveError)

  if (result.holdback) {
    const { error } = await admin.from('ingestion_records').update({ holdback: true }).eq('id', record.id)
    if (error) fail('Failed to mark the audit sample.', error)
  }

  await appendAudit({
    orgId: record.org_id,
    recordId: record.id,
    actor: { type: 'system' },
    event: 'routing.decided',
    payload: {
      decision: result.decision,
      reasons: result.reasons,
      aggregate: recordRow?.score ?? 0,
      validation: result.validation,
      rule_version: result.ruleVersion,
    },
  })

  if (result.decision === 'auto_commit') return { kind: 'advance' }
  const [primary] = result.reasons
  return {
    kind: 'escalate',
    reason: primary ?? 'below_threshold',
    priority: result.priority,
    ...(result.holdback ? { taskKind: 'holdback_audit' as const } : {}),
  }
}
