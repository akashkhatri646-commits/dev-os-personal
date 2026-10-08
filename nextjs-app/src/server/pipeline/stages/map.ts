import 'server-only'
import { randomUUID } from 'node:crypto'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getEnv } from '@/server/config/env'
import type { StageContext, StageOutcome } from '@/server/pipeline/stages'
import { appendAudit } from '@/server/services/audit/auditLog'
import { assertConsentValid } from '@/server/services/consent/ConsentService'
import { buildResources, type BuiltResource } from '@/server/services/fhir/builders'
import { getLlmClient } from '@/server/services/llm/LLMClient'
import { groupFields, type StoredField } from '@/server/services/mapping/entities'
import { mapCodes, planMappingItems, type MappingOutcome } from '@/server/services/mapping/map'
import { BUDGET_DEFER_SECONDS, budgetExceeded, recordSpend } from '@/server/services/safety/budget'
import { getActiveMappingPrompt } from '@/server/services/prompts/promptVersions'
import { loadTermDictionary } from '@/server/services/terminology/dictionary'
import { getEmbeddingsClient, SupabaseTerminologySearch } from '@/server/services/terminology/search'
import type { Coding } from '@/types/domain'

async function loadFields(recordId: string): Promise<StoredField[]> {
  const { data, error } = await getSupabaseAdmin()
    .from('extracted_fields')
    .select('field_key, found, value, source_span, basis, model_confidence')
    .eq('record_id', recordId)
    .eq('found', true)
  if (error) throw new AppError('INTERNAL', 'Failed to load the extracted fields.', { cause: error, retryable: true })
  return (data ?? []) as StoredField[]
}

async function addCost(recordId: string, usd: number): Promise<void> {
  const admin = getSupabaseAdmin()
  const { data } = await admin.from('ingestion_records').select('cost_usd').eq('id', recordId).maybeSingle()
  const current = Number(data?.cost_usd ?? 0)
  await admin.from('ingestion_records').update({ cost_usd: Math.round((current + usd) * 10_000) / 10_000 }).eq('id', recordId)
}

/** Replaces the record's mapped resources, so re-running the stage never duplicates them. */
async function saveResources(recordId: string, built: readonly BuiltResource[]): Promise<void> {
  const admin = getSupabaseAdmin()
  const { error: deleteError } = await admin.from('mapped_resources').delete().eq('record_id', recordId)
  if (deleteError) throw new AppError('INTERNAL', 'Failed to clear previous mapped resources.', { cause: deleteError, retryable: true })
  if (built.length === 0) return
  const { error } = await admin.from('mapped_resources').insert(
    built.map((entry) => ({
      id: entry.id,
      record_id: recordId,
      resource_type: entry.resourceType,
      resource: entry.resource,
      codings: entry.codings,
      flags: entry.flags,
      source_ref: entry.sourceRef,
      profile_url: entry.profileUrl,
      validation_status: 'pending',
      validation_issues: [],
    })),
  )
  if (error) throw new AppError('INTERNAL', 'Failed to save the mapped resources.', { cause: error, retryable: true })
}

/**
 * Component 4a: turns grounded fields into FHIR resources. The model only chooses among candidate
 * concepts found in the terminology store, by id; anything it cannot match stays uncoded and is
 * flagged. Resources are built only from grounded fields, and no required element is ever invented.
 *
 * Runs only after a valid consent check (re-asserted here).
 */
export async function mapStage({ record }: StageContext): Promise<StageOutcome> {
  await assertConsentValid(record.id)
  if (!record.patient_id) return { kind: 'fail', reason: 'patient_missing' }

  const instances = groupFields(await loadFields(record.id))
  if (instances.length === 0) return { kind: 'escalate', reason: 'no_data_extracted' }

  const search = new SupabaseTerminologySearch(getEmbeddingsClient())
  const { items } = await planMappingItems(instances, search, await loadTermDictionary())

  let mapped: MappingOutcome = { codings: new Map<string, Coding>(), invalidSelections: new Set<string>(), usage: { inputTokens: 0, outputTokens: 0 }, costUsd: null }
  let promptVersion: string | null = null
  if (items.length > 0) {
    const env = getEnv()
    const llm = getLlmClient()
    const model = env.LLM_MODEL_LIGHT ?? env.LLM_MODEL_EXTRACTION
    if (!llm || !model) return { kind: 'escalate', reason: 'mapping_unavailable' }
    if (await budgetExceeded()) return { kind: 'defer', seconds: BUDGET_DEFER_SECONDS }
    const prompt = await getActiveMappingPrompt(model)
    promptVersion = prompt.version
    mapped = await mapCodes(items, {
      llm,
      model,
      system: prompt.template,
      recordId: record.id,
      maxTokens: env.LLM_MAX_OUTPUT_TOKENS,
      timeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
    })
    if (mapped.costUsd !== null) {
      await addCost(record.id, mapped.costUsd)
      await recordSpend(mapped.costUsd)
    }
  }

  const built = buildResources(instances, {
    patientId: record.patient_id,
    encounterId: null,
    newId: () => randomUUID(),
    codings: mapped.codings,
    invalidSelections: mapped.invalidSelections,
  })
  if (built.length === 0) return { kind: 'escalate', reason: 'no_data_extracted' }
  await saveResources(record.id, built)

  await appendAudit({
    orgId: record.org_id,
    recordId: record.id,
    actor: { type: 'system' },
    event: 'mapping.completed',
    payload: {
      resources: built.length,
      coded: mapped.codings.size,
      uncoded: built.filter((entry) => entry.flags.includes('uncoded')).length,
      rejected_selections: mapped.invalidSelections.size,
      prompt_version: promptVersion,
      input_tokens: mapped.usage.inputTokens,
      output_tokens: mapped.usage.outputTokens,
    },
  })
  return { kind: 'advance' }
}
