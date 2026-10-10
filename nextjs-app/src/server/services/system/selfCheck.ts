import 'server-only'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getEnv } from '@/server/config/env'

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface SelfCheckItem {
  id: string
  label: string
  status: CheckStatus
  /** What is wrong and what to do about it. Never includes secret values. */
  detail: string
}

export interface SelfCheckGroup {
  title: string
  items: SelfCheckItem[]
}

export interface SelfCheckResult {
  ok: boolean
  checked_at: string
  groups: SelfCheckGroup[]
}

const item = (id: string, label: string, status: CheckStatus, detail: string): SelfCheckItem => ({ id, label, status, detail })

/** Tables the pipeline reads or writes. */
const TABLES = [
  'organizations', 'profiles', 'provider_sources', 'source_api_keys', 'patients', 'consent_artifacts', 'prompt_versions',
  'ingestion_records', 'documents', 'consent_checks', 'extracted_fields', 'mapped_resources', 'field_scores', 'routing_thresholds',
  'routing_decisions', 'review_tasks', 'review_corrections', 'fhir_resources', 'fhir_resource_versions', 'provenance', 'audit_log',
  'pipeline_jobs', 'terminology_concepts', 'knowledge_docs', 'downstream_errors', 'source_flags', 'llm_spend_daily',
]

/** Columns added by a migration after the first one: a missing column means that migration was not applied. */
const MIGRATION_COLUMNS = [
  { migration: '0004_mapped_resource_flags', table: 'mapped_resources', column: 'flags' },
  { migration: '0005_mapped_resource_source_ref', table: 'mapped_resources', column: 'source_ref' },
  { migration: '0010_source_evaluation', table: 'provider_sources', column: 'eval_basis' },
]

/**
 * Functions created by the migrations, probed with the right parameter names but a malformed first value, so the call
 * fails on the value (the function exists) or on the name (it does not) and never does any work.
 */
const FUNCTIONS: { migration: string; name: string; args: Record<string, unknown> }[] = [
  { migration: '0001_baseline', name: 'claim_jobs', args: { p_limit: 'x', p_worker: 'self-check' } },
  { migration: '0001_baseline', name: 'commit_record', args: { p_record_id: 'x', p_mode: 'x', p_reviewer_id: null } },
  {
    migration: '0002_source_functions',
    name: 'create_source_with_defaults',
    args: { p_org: 'x', p_created_by: 'x', p_name: 'x', p_provider_type: 'x', p_size_class: 'x', p_region: 'x', p_language: 'x', p_doc_types: 'x', p_regime: 'x', p_holdback: 'x', p_default_threshold: 'x', p_high_risk_threshold: 'x', p_key_prefix: 'x', p_key_hash: 'x' },
  },
  { migration: '0002_source_functions', name: 'set_routing_threshold', args: { p_source: 'x', p_resource_type: 'x', p_threshold: 'x', p_reason: 'x', p_changed_by: 'x' } },
  { migration: '0002_source_functions', name: 'rotate_source_key', args: { p_source: 'x', p_key_prefix: 'x', p_key_hash: 'x' } },
  { migration: '0003_audit_functions', name: 'check_audit_rows', args: { p_org: 'x', p_ids: 'x' } },
  {
    migration: '0006_review_functions',
    name: 'submit_review',
    args: { p_task: 'x', p_reviewer: 'x', p_resources: 'x', p_deleted_resources: 'x', p_fields: 'x', p_removed_fields: 'x', p_corrections: 'x', p_counts: 'x' },
  },
  { migration: '0006_review_functions', name: 'reject_review', args: { p_task: 'x', p_reviewer: 'x', p_corrections: 'x', p_counts: 'x' } },
  { migration: '0007_safety_controls', name: 'add_llm_spend', args: { p_usd: 'x' } },
  { migration: '0008_rate_limit', name: 'rate_limit_hit', args: { p_key: 'x', p_limit: 'x', p_window_seconds: 'x' } },
]

interface DbError {
  code?: string
  message?: string
}

const isMissingFunction = (error: DbError | null) => error?.code === 'PGRST202' || /could not find the function/i.test(error?.message ?? '')
const isMissingTable = (error: DbError | null) => error?.code === '42P01' || error?.code === 'PGRST205'
const isMissingColumn = (error: DbError | null) => error?.code === '42703' || /column .* does not exist/i.test(error?.message ?? '')

function environmentChecks(): SelfCheckGroup {
  const env = getEnv()
  const items: SelfCheckItem[] = []

  items.push(
    env.WORKER_SECRET
      ? item('worker-secret', 'Worker secret', 'ok', 'Set.')
      : item('worker-secret', 'Worker secret', 'fail', 'WORKER_SECRET is not set (32+ characters). Without it no record is ever processed.'),
  )
  const local = /localhost|127\.0\.0\.1/.test(env.APP_BASE_URL)
  items.push(
    local && process.env.NODE_ENV === 'production'
      ? item('base-url', 'App base URL', 'warn', 'APP_BASE_URL points to localhost in a production build. The worker trigger will not reach the app.')
      : item('base-url', 'App base URL', 'ok', `Set (${new URL(env.APP_BASE_URL).host}).`),
  )

  if (process.env.NODE_ENV === 'production' && !local) {
    const setting = env.WORKER_HOST_LIMIT_SECONDS
    const confirmed = env.WORKER_HOST_LIMIT_CONFIRMED
    items.push(
      confirmed
        ? item('host-limit', 'Worker time limit', 'ok', `A longer host limit (${setting ?? 'unset'} s) was confirmed; passes are sized to it.`)
        : (setting ?? 26) > 26
          ? item('host-limit', 'Worker time limit', 'warn', `WORKER_HOST_LIMIT_SECONDS is ${setting}, but the worker plans for 26 s (the Free plan) until WORKER_HOST_LIMIT_CONFIRMED=true is set after running /api/internal/limit-probe. Set it to 26 to match.`)
          : env.LLM_REQUEST_TIMEOUT_MS / 1000 > 20
            ? item('host-limit', 'Worker time limit', 'warn', `LLM_REQUEST_TIMEOUT_MS is ${env.LLM_REQUEST_TIMEOUT_MS} ms: with a 26 s host limit a model call must finish within about 20 s. Set it to 20000.`)
            : item('host-limit', 'Worker time limit', 'ok', 'Passes are sized to the 26 s Free-plan limit; a job a cut-off pass leaves behind is reclaimed within about 40 s.'),
    )
  }

  if (!env.LLM_PROVIDER) {
    items.push(item('llm-provider', 'Language model', 'fail', 'LLM_PROVIDER is not set. Extraction and coding will send every record to review as "llm_unavailable".'))
  } else {
    const keyOk = env.LLM_PROVIDER === 'openai' ? !!env.OPENAI_API_KEY : !!env.AZURE_OPENAI_API_KEY && !!env.AZURE_OPENAI_ENDPOINT
    items.push(
      keyOk
        ? item('llm-provider', 'Language model', 'ok', `Provider ${env.LLM_PROVIDER} is configured. Use "Test the model" for a live check.`)
        : item('llm-provider', 'Language model', 'fail', `${env.LLM_PROVIDER === 'openai' ? 'OPENAI_API_KEY' : 'AZURE_OPENAI_API_KEY / AZURE_OPENAI_ENDPOINT'} is missing.`),
    )
  }
  items.push(
    env.LLM_MODEL_EXTRACTION
      ? item('llm-model', 'Extraction model', 'ok', `Model ${env.LLM_MODEL_EXTRACTION}${env.LLM_MODEL_LIGHT ? `, light model ${env.LLM_MODEL_LIGHT}` : ''}.`)
      : item('llm-model', 'Extraction model', 'fail', 'LLM_MODEL_EXTRACTION is not set.'),
  )
  items.push(
    env.LLM_PRICE_INPUT_PER_MTOK !== undefined && env.LLM_PRICE_OUTPUT_PER_MTOK !== undefined
      ? item('llm-price', 'Model prices', 'ok', 'Set: cost and the daily budget are tracked.')
      : item('llm-price', 'Model prices', 'warn', 'LLM_PRICE_INPUT_PER_MTOK / LLM_PRICE_OUTPUT_PER_MTOK are not set: cost shows as zero and the daily budget cannot stop spending.'),
  )
  items.push(
    env.EMBEDDINGS_MODEL
      ? item('embeddings', 'Embeddings', 'ok', `Model ${env.EMBEDDINGS_MODEL}.`)
      : item('embeddings', 'Embeddings', 'warn', 'EMBEDDINGS_MODEL is not set: terminology search uses word matching only.'),
  )
  items.push(
    env.OCR_PROVIDER
      ? item('ocr', 'Scan reading (OCR)', 'ok', `Provider ${env.OCR_PROVIDER}.`)
      : item('ocr', 'Scan reading (OCR)', 'warn', 'No OCR provider: scanned or image-only documents are sent to review as "ocr_unavailable". Typed PDFs and text are unaffected.'),
  )
  items.push(
    env.SYSTEM_AUTOCOMMIT_ENABLED
      ? item('autocommit', 'Automatic commit', 'ok', 'Enabled system-wide (sources still need auto-commit switched on).')
      : item('autocommit', 'Automatic commit', 'warn', 'SYSTEM_AUTOCOMMIT_ENABLED is not "true": every record goes to human review. Expected until accuracy is validated.'),
  )
  return { title: 'Environment', items }
}

async function databaseChecks(): Promise<SelfCheckGroup[]> {
  const admin = getSupabaseAdmin()
  const bucketName = getEnv().SUPABASE_STORAGE_BUCKET

  const probes = await Promise.all(
    TABLES.map(async (table) => ({ table, error: (await admin.from(table).select('*', { head: true, count: 'exact' }).limit(1)).error })),
  )
  const problems = probes
    .filter((probe) => probe.error)
    .map((probe) => `${probe.table} (${isMissingTable(probe.error) ? 'missing' : (probe.error?.code ?? 'error')})`)
  const tables =
    problems.length === 0
      ? item('tables', 'Tables', 'ok', `All ${TABLES.length} tables are reachable.`)
      : item('tables', 'Tables', 'fail', `Problem with: ${problems.join(', ')}. Run supabase/migrations/0001_baseline.sql, or check SUPABASE_SERVICE_ROLE_KEY and the project URL.`)

  const migrationItems: SelfCheckItem[] = []
  const columnFailures = new Set<string>()
  for (const entry of MIGRATION_COLUMNS) {
    const { error } = await admin.from(entry.table).select(entry.column).limit(1)
    if (!error) migrationItems.push(item(entry.migration, `Migration ${entry.migration}`, 'ok', 'Applied.'))
    else if (isMissingColumn(error)) {
      columnFailures.add(entry.migration)
      migrationItems.push(item(entry.migration, `Migration ${entry.migration}`, 'fail', `Not applied: ${entry.table}.${entry.column} is missing. Run supabase/migrations/${entry.migration}.sql in the SQL editor.`))
    } else migrationItems.push(item(entry.migration, `Migration ${entry.migration}`, 'warn', `Could not be checked (${error.code ?? 'error'}).`))
  }

  const results = await Promise.all(
    FUNCTIONS.map(async (fn) => ({ fn, error: (await admin.rpc(fn.name as never, fn.args as never)).error as DbError | null })),
  )
  const missing = new Map<string, string[]>()
  for (const { fn, error } of results) {
    if (isMissingFunction(error)) missing.set(fn.migration, [...(missing.get(fn.migration) ?? []), fn.name])
  }
  for (const migration of new Set(FUNCTIONS.map((fn) => fn.migration))) {
    const names = missing.get(migration)
    if (names) {
      migrationItems.push(item(`${migration}-functions`, `Functions from ${migration}`, 'fail', `Missing: ${names.join(', ')}. Run supabase/migrations/${migration}.sql in the SQL editor.`))
    } else if (!migrationItems.some((entry) => entry.id === migration)) {
      migrationItems.push(item(migration, `Migration ${migration}`, 'ok', 'Its functions exist.'))
    }
  }

  const { error: bucketError } = await admin.storage.getBucket(bucketName)
  const storage = bucketError
    ? item('bucket', 'Document storage', 'fail', `Bucket "${bucketName}" was not found. Create it as a private bucket in Supabase Storage.`)
    : item('bucket', 'Document storage', 'ok', `Bucket "${bucketName}" exists.`)

  return [
    { title: 'Database', items: [tables] },
    { title: 'Migrations', items: migrationItems },
    { title: 'Storage', items: [storage] },
  ]
}

async function dataChecks(): Promise<SelfCheckGroup> {
  const admin = getSupabaseAdmin()
  const items: SelfCheckItem[] = []

  const { count: concepts, error: conceptError } = await admin.from('terminology_concepts').select('id', { head: true, count: 'exact' })
  if (!conceptError) {
    items.push(
      (concepts ?? 0) > 0
        ? item('terminology', 'Terminology', 'ok', `${concepts} concepts loaded.`)
        : item('terminology', 'Terminology', 'warn', 'No concepts loaded, so nothing can be coded. For development run supabase/seed/terminology-sample.sql; for real use load licensed SNOMED, LOINC and ICD-10.'),
    )
  }

  const { count: dead } = await admin.from('pipeline_jobs').select('id', { head: true, count: 'exact' }).eq('status', 'dead')
  items.push(
    (dead ?? 0) > 0
      ? item('dead-jobs', 'Failed jobs', 'warn', `${dead} job(s) gave up after retries. Open the affected records to retry or re-run them.`)
      : item('dead-jobs', 'Failed jobs', 'ok', 'None.'),
  )

  const overdueBefore = new Date(Date.now() - 10 * 60_000).toISOString()
  const { count: overdue } = await admin.from('pipeline_jobs').select('id', { head: true, count: 'exact' }).eq('status', 'queued').lt('run_at', overdueBefore)
  items.push(
    (overdue ?? 0) > 0
      ? item('stale-jobs', 'Waiting jobs', 'fail', `${overdue} job(s) have been due for over 10 minutes, so the worker is not running. Locally start "npm run dev:all" (or "npm run worker:dev"); in production check the scheduled function.`)
      : item('stale-jobs', 'Waiting jobs', 'ok', 'Nothing is overdue.'),
  )

  const stuckBefore = new Date(Date.now() - 90_000).toISOString()
  const { count: stuck } = await admin.from('pipeline_jobs').select('id', { head: true, count: 'exact' }).eq('status', 'running').lt('locked_at', stuckBefore)
  items.push(
    (stuck ?? 0) > 0
      ? item('stuck-jobs', 'Jobs left running', 'warn', `${stuck} job(s) have been running for over 90 s: a worker pass was cut off. The next pass reclaims them; if this stays, check WORKER_HOST_LIMIT_SECONDS.`)
      : item('stuck-jobs', 'Jobs left running', 'ok', 'None.'),
  )

  const { data: spend } = await admin.rpc('get_llm_spend')
  if (spend !== null && spend !== undefined) {
    items.push(item('spend', 'Model spend today', 'ok', `${Number(spend).toFixed(4)} USD of ${getEnv().LLM_DAILY_BUDGET_USD} USD.`))
  }
  return { title: 'Data and queue', items }
}

/** Reads the deployment's configuration and database and reports anything that would break a flow. Admin only; changes nothing. */
export async function runSelfCheck(): Promise<SelfCheckResult> {
  const groups: SelfCheckGroup[] = [environmentChecks()]
  try {
    groups.push(...(await databaseChecks()), await dataChecks())
  } catch {
    groups.push({ title: 'Database', items: [item('db', 'Database', 'fail', 'The database could not be reached. Check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.')] })
  }
  return { ok: groups.every((group) => group.items.every((entry) => entry.status !== 'fail')), checked_at: new Date().toISOString(), groups }
}
