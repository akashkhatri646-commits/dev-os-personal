import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { DISCHARGE_SUMMARY_CATALOG, FIELD_KEY_PATTERN } from '@/server/services/extraction/fieldCatalog'
import { CODEABLE_FIELDS } from '@/server/services/mapping/map'
import type { EvalFieldInput, EvalRecordInput } from '@/server/services/evaluation/compute'

const PAGE = 1000
const CHUNK = 100

interface CorrectionRow {
  task_id: string
  record_id: string
  field_key: string
  action: 'accept' | 'correct' | 'reject'
  original_value: unknown
  original_code: { code?: string } | null
  corrected_code: { code?: string } | null
  reviewed_at: string
}

const fail = (message: string, cause: unknown): never => {
  throw new AppError('INTERNAL', message, { cause })
}

/** Reads every page of a query: the API returns at most 1000 rows at a time. */
async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, what: string): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) fail(`Failed to load ${what}.`, error)
    rows.push(...(data ?? []))
    if ((data ?? []).length < PAGE) return rows
  }
}

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size))
  return out
}

/** Resource type of an entity (`medication` -> MedicationRequest), used when the stored field row is gone. */
const RESOURCE_OF_ENTITY = new Map(DISCHARGE_SUMMARY_CATALOG.map((spec) => [spec.entity, spec.resourceType as string]))

/**
 * Loads what reviewers decided for a source, joined with what the system produced: one entry per field, the latest
 * decision winning when a record was reviewed more than once. Reads only field names, flags, scores and decisions;
 * document text and patient identifiers are never selected.
 */
export async function loadEvaluationInputs(
  sourceId: string,
  sinceIso: string | null,
): Promise<{ fields: EvalFieldInput[]; records: EvalRecordInput[] }> {
  const admin = getSupabaseAdmin()

  const corrections = await readAll<CorrectionRow>(
    (from, to) => {
      let query = admin
        .from('review_corrections')
        .select('task_id, record_id, field_key, action, original_value, original_code, corrected_code, reviewed_at')
        .eq('source_id', sourceId)
        .order('reviewed_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
      if (sinceIso) query = query.gte('reviewed_at', sinceIso)
      return query as unknown as PromiseLike<{ data: CorrectionRow[] | null; error: unknown }>
    },
    'the reviewer decisions',
  )

  // The latest decision for each field of each record (ascending order: later rows overwrite earlier ones).
  const latest = new Map<string, CorrectionRow>()
  for (const row of corrections) latest.set(`${row.record_id}|${row.field_key}`, row)
  const decisions = [...latest.values()]
  const recordIds = [...new Set(decisions.map((row) => row.record_id))]
  const taskIds = [...new Set(decisions.map((row) => row.task_id))]

  const extracted = new Map<string, { resource_type: string; found: boolean; grounded: boolean; basis: 'stated' | 'inferred' | null }>()
  const scores = new Map<string, { score: number; required: boolean }>()
  const reasons = new Map<string, string[]>()
  const tasks = new Map<string, { claimed_at: string | null; completed_at: string | null }>()

  for (const ids of chunks(recordIds, CHUNK)) {
    const [fieldRows, scoreRows, decisionRows] = await Promise.all([
      readAll<{ record_id: string; field_key: string; resource_type: string; found: boolean; grounded: boolean; basis: 'stated' | 'inferred' | null }>(
        (from, to) => admin.from('extracted_fields').select('record_id, field_key, resource_type, found, grounded, basis').in('record_id', ids).range(from, to) as never,
        'the extracted fields',
      ),
      readAll<{ record_id: string; field_key: string; score: number | string; components: { required?: boolean } | null }>(
        (from, to) => admin.from('field_scores').select('record_id, field_key, score, components').eq('scope', 'field').in('record_id', ids).range(from, to) as never,
        'the field scores',
      ),
      readAll<{ record_id: string; escalation_reasons: string[] | null }>(
        (from, to) => admin.from('routing_decisions').select('record_id, escalation_reasons').in('record_id', ids).range(from, to) as never,
        'the routing decisions',
      ),
    ])
    for (const row of fieldRows) extracted.set(`${row.record_id}|${row.field_key}`, row)
    for (const row of scoreRows) scores.set(`${row.record_id}|${row.field_key}`, { score: Number(row.score), required: row.components?.required === true })
    for (const row of decisionRows) reasons.set(row.record_id, row.escalation_reasons ?? [])
  }
  for (const ids of chunks(taskIds, CHUNK)) {
    const rows = await readAll<{ id: string; claimed_at: string | null; completed_at: string | null }>(
      (from, to) => admin.from('review_tasks').select('id, claimed_at, completed_at').in('id', ids).range(from, to) as never,
      'the review tasks',
    )
    for (const row of rows) tasks.set(row.id, row)
  }

  const fields: EvalFieldInput[] = decisions.map((row) => {
    const stored = extracted.get(`${row.record_id}|${row.field_key}`)
    const parsed = FIELD_KEY_PATTERN.exec(row.field_key)
    const entity = parsed?.[1] ?? ''
    const attribute = parsed?.[3] ?? ''
    const score = scores.get(`${row.record_id}|${row.field_key}`)
    // Rejected records have their extracted rows purged: fall back to what the decision itself recorded.
    const found = stored ? stored.found : row.original_value !== null && row.original_value !== undefined
    const codeChanged =
      row.action === 'correct' && row.corrected_code !== null && (row.original_code?.code ?? null) !== (row.corrected_code?.code ?? null)
    return {
      recordId: row.record_id,
      fieldKey: row.field_key,
      resourceType: stored?.resource_type ?? RESOURCE_OF_ENTITY.get(entity) ?? 'Unknown',
      action: row.action,
      found,
      codeable: CODEABLE_FIELDS.some((spec) => spec.entity === entity && spec.attribute === attribute),
      codeWrong: codeChanged,
      score: score ? score.score : null,
      required: score?.required ?? false,
      basis: stored?.basis ?? null,
      grounded: stored ? stored.grounded : true,
    }
  })

  const records: EvalRecordInput[] = recordIds.map((recordId) => {
    const taskId = decisions.filter((row) => row.record_id === recordId).at(-1)?.task_id
    const task = taskId ? tasks.get(taskId) : undefined
    const seconds = task?.claimed_at && task.completed_at ? (Date.parse(task.completed_at) - Date.parse(task.claimed_at)) / 1000 : null
    return { recordId, holdback: (reasons.get(recordId) ?? []).includes('holdback'), decisionSeconds: seconds !== null && seconds >= 0 ? seconds : null }
  })

  return { fields, records }
}
