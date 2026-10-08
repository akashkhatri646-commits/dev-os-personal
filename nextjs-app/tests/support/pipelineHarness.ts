import type { Mock } from 'vitest'
import { enqueueJob } from '@/server/queue/jobs'
import { resetBreakerCache } from '@/server/services/safety/breaker'
import { runTick } from '@/server/worker/tick'
import { FakeDb } from './fakeDb'
import { DISCHARGE_FIELDS, DISCHARGE_TEXT, emulateClaimJobs, emulateCommitRecord, emulateSubmitReview, extractionFor, mappingFor, type FieldSpec } from './fixtures'

export const ORG = 'org-1'
export const SOURCE = 'src-1'
export const PATIENT = 'pat-1'
export const VALID = { result: 'valid', artifactId: 'art-1', matchedScope: ['DischargeSummary'], detail: {} }

export { BASE_ENV } from './baseEnv'

export interface Holder {
  db: FakeDb
  files: Map<string, Buffer>
  llm: unknown
  consent: unknown
  env: Record<string, unknown>
}

export interface Spies {
  download: Mock
  llm: Mock
  alert: Mock
  consent: Mock
}

export interface ModelOptions {
  fields?: FieldSpec[]
  confidence?: number
  /** Called for each model call; throw to simulate a vendor failure. */
  before?: (component: string, callNumber: number) => void
}

export interface SubmitOptions {
  text?: string
  autoCommit?: boolean
  holdbackPct?: number
}

/** Builds the helpers a test file uses to drive the real worker against the fake database. */
export function createHarness(holder: Holder, spies: Spies) {
  function makeModel(options: ModelOptions = {}) {
    let calls = 0
    return {
      async complete(request: { component: string; schema: { parse: (raw: unknown) => unknown }; messages: { content: unknown }[] }) {
        calls += 1
        spies.llm(request.component)
        options.before?.(request.component, calls)
        const pages = holder.db.table('documents')[0]?.normalized_text
        const raw = request.component === 'extraction' ? extractionFor(pages, options.fields ?? DISCHARGE_FIELDS, options.confidence) : mappingFor(request.messages[0]?.content)
        return { output: request.schema.parse(raw), usage: { inputTokens: 100, outputTokens: 50 }, costUsd: 0.01, latencyMs: 5, model: 'test-model' }
      },
    }
  }

  /** A fresh world: empty database with one enabled source, a 0.95 threshold and a valid consent. */
  function reset() {
    resetBreakerCache()
    const db = new FakeDb()
    db.rpcHandlers = {
      claim_jobs: emulateClaimJobs,
      commit_record: emulateCommitRecord,
      submit_review: emulateSubmitReview,
      get_llm_spend: () => ({ data: 0, error: null }),
      add_llm_spend: () => ({ data: [0, 0.01], error: null }),
      release_expired_review_locks: () => ({ data: 0, error: null }),
      check_audit_rows: (args) => ({ data: (args.p_ids as number[]).map((id) => ({ id, hash_ok: true })), error: null }),
    }
    holder.db = db
    holder.files = new Map()
    holder.llm = makeModel()
    holder.consent = VALID
    holder.env = {}
    db.seed('provider_sources', {
      id: SOURCE,
      org_id: ORG,
      name: 'City Hospital',
      provider_type: 'hospital',
      size_class: 'medium',
      region: 'IN-KA',
      primary_language: 'en',
      doc_types: ['discharge_summary'],
      consent_regime: 'abdm',
      auto_commit_enabled: true,
      holdback_pct: 0,
      pause_reason: null,
      eval_status: 'passed',
      eval_passed_at: new Date().toISOString(),
      flagged_poor: false,
    })
    db.seed('routing_thresholds', { source_id: SOURCE, resource_type: '*', threshold: 0.95, version: 1, active: true, reason: 'initial threshold', changed_by: null })
  }

  async function submit(options: SubmitOptions = {}): Promise<string> {
    const db = holder.db
    const [created] = db.seed('ingestion_records', {
      org_id: ORG,
      source_id: SOURCE,
      patient_id: PATIENT,
      doc_type: 'discharge_summary',
      input_kind: 'text',
      data_categories: ['DischargeSummary'],
      content_sha256: `sha-${db.table('ingestion_records').length}`,
    }) as [{ id: string }]
    const path = `${ORG}/${created.id}/note.txt`
    holder.files.set(path, Buffer.from(options.text ?? DISCHARGE_TEXT, 'utf8'))
    db.seed('documents', { record_id: created.id, storage_path: path, mime_type: 'text/plain', bytes: 500 })
    await enqueueJob(created.id, 'consent_check')
    const source = db.find('provider_sources', (row) => row.id === SOURCE)
    if (source) Object.assign(source, { auto_commit_enabled: options.autoCommit ?? source.auto_commit_enabled, holdback_pct: options.holdbackPct ?? source.holdback_pct })
    return created.id
  }

  /** Runs the worker until no job is left to claim (or `maxTicks`, for scenarios where jobs are held back). */
  async function drain(maxTicks = 30) {
    const summaries = []
    for (let tick = 0; tick < maxTicks; tick += 1) {
      const summary = await runTick({ batchSize: 5, maxSeconds: 50, workerId: `worker-${tick}` })
      summaries.push(summary)
      if (summary.claimed === 0) break
    }
    return summaries
  }

  const record = (id: string) => holder.db.find('ingestion_records', (row) => row.id === id)!
  const events = (id: string) => holder.db.all('audit_log', (row) => row.record_id === id).map((row) => row.event as string)
  const task = (id: string) => holder.db.find('review_tasks', (row) => row.record_id === id)

  return { makeModel, reset, submit, drain, record, events, task }
}
