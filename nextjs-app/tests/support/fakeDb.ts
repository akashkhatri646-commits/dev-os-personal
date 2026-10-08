import { createHash, randomUUID } from 'node:crypto'

/**
 * A small in-memory stand-in for the Supabase client, enough for the pipeline's real stage code to
 * run end to end in tests: tables are arrays of rows, queries are applied for real (filters, order,
 * limits, upsert conflicts, unique constraints), and the few database functions the pipeline calls
 * are emulated in `rpcHandlers`. It is not Postgres: row-level security, triggers and the SQL of
 * `commit_record` are covered by `tests/sql/acceptance.sql` against a real database.
 */
export type Row = Record<string, any>
type Result = { data: any; error: { code?: string; message: string } | null; count?: number | null }
type Filter = (row: Row) => boolean

const UNIQUE_VIOLATION = '23505'

/** A column of a row, or of an embedded relation for `relation.column`. */
const valueAt = (row: Row, column: string): any => column.split('.').reduce<any>((value, part) => (value === null || value === undefined ? undefined : value[part]), row)

const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value))
const nowIso = () => new Date().toISOString()

/** Column defaults, as the schema declares them. */
const DEFAULTS: Record<string, () => Row> = {
  ingestion_records: () => ({ status: 'received', holdback: false, prompt_set: {}, cost_usd: 0, status_reason: null, patient_id: null, latency_ms: null, completed_at: null }),
  pipeline_jobs: () => ({ status: 'queued', attempts: 0, max_attempts: 2, run_at: nowIso(), locked_at: null, locked_by: null, last_error: null }),
  review_tasks: () => ({ status: 'open', kind: 'escalation', priority: 0, claimed_by: null, claimed_at: null, lock_expires_at: null, completed_at: null }),
  mapped_resources: () => ({ validation_status: 'pending', validation_issues: [], flags: [], codings: [], source_ref: null, profile_url: null }),
  extracted_fields: () => ({ grounded: false }),
  documents: () => ({ ocr_engine: null, ocr_confidence: null, normalized_text: null, page_count: null }),
  prompt_versions: () => ({ active: false, few_shot: [] }),
  fhir_resources: () => ({ version_id: 1, ai_extracted: true }),
  review_corrections: () => ({ reviewed_at: nowIso() }),
  provenance: () => ({ committed_at: nowIso(), reviewer_id: null }),
  downstream_errors: () => ({ status: 'open', source_paused: false, root_cause: null, resolution_note: null, resolved_by: null, resolved_at: null }),
  consent_checks: () => ({ artifact_id: null, matched_scope: [], detail: null }),
}

/** Unique constraints (partial ones included) that code relies on to make repeats harmless. */
const UNIQUE: Record<string, ((a: Row, b: Row) => boolean)[]> = {
  pipeline_jobs: [(a, b) => a.record_id === b.record_id && a.stage === b.stage && ['queued', 'running'].includes(a.status) && ['queued', 'running'].includes(b.status)],
  review_tasks: [(a, b) => a.record_id === b.record_id && a.kind === b.kind && ['open', 'claimed'].includes(a.status) && ['open', 'claimed'].includes(b.status)],
  extracted_fields: [(a, b) => a.record_id === b.record_id && a.field_key === b.field_key],
  routing_decisions: [(a, b) => a.record_id === b.record_id],
  consent_checks: [(a, b) => a.record_id === b.record_id],
  prompt_versions: [(a, b) => a.component === b.component && a.version === b.version, (a, b) => a.component === b.component && a.active && b.active],
}

/** Embedded selects such as `ingestion_records!inner(source_id)`: which column on the parent points at which table. */
const RELATIONS: Record<string, Record<string, { foreignKey: string }>> = {
  downstream_errors: { ingestion_records: { foreignKey: 'record_id' } },
  review_tasks: { ingestion_records: { foreignKey: 'record_id' } },
  ingestion_records: { provider_sources: { foreignKey: 'source_id' } },
  audit_log: { ingestion_records: { foreignKey: 'record_id' } },
}

interface Embed {
  name: string
  inner: boolean
  nested: string
}

/** The embedded relations named in a select list, at the top level only; their own columns are not narrowed. */
function parseEmbeds(columns: string | undefined): Embed[] {
  if (!columns) return []
  const embeds: Embed[] = []
  let depth = 0
  let token = ''
  let start = -1
  for (let index = 0; index < columns.length; index += 1) {
    const char = columns[index] as string
    if (char === '(') {
      if (depth === 0) start = index
      depth += 1
    } else if (char === ')') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        const name = token.trim().split(',').pop()?.trim() ?? ''
        const inner = name.endsWith('!inner')
        embeds.push({ name: name.replace('!inner', ''), inner, nested: columns.slice(start + 1, index) })
        token = ''
        start = -1
      }
    } else if (depth === 0) token += char
  }
  return embeds
}

export class FakeDb {
  readonly tables = new Map<string, Row[]>()
  readonly rpcCalls: { name: string; args: Row }[] = []
  rpcHandlers: Record<string, (args: Row, db: FakeDb) => { data: any; error: Result['error'] }> = {}
  private auditSeq = 0

  table(name: string): Row[] {
    let rows = this.tables.get(name)
    if (!rows) {
      rows = []
      this.tables.set(name, rows)
    }
    return rows
  }

  /** Test helper: insert rows directly, with defaults and an id. */
  seed(name: string, ...rows: Row[]): Row[] {
    return rows.map((row) => this.insertRow(name, row))
  }

  find(name: string, predicate: Filter): Row | undefined {
    return this.table(name).find(predicate)
  }

  all(name: string, predicate: Filter = () => true): Row[] {
    return this.table(name).filter(predicate).map(clone)
  }

  insertRow(name: string, input: Row): Row {
    const row: Row = { ...(DEFAULTS[name]?.() ?? {}), ...clone(input) }
    if (!('id' in row)) row.id = name === 'audit_log' ? ++this.auditSeq : randomUUID()
    row.created_at ??= nowIso()
    row.updated_at ??= row.created_at
    if (name === 'audit_log') {
      // The database trigger chains each entry to the previous one of the same organisation.
      const previous = [...this.table('audit_log')].reverse().find((entry) => entry.org_id === row.org_id)
      row.prev_hash = previous?.hash ?? null
      row.hash = createHash('sha256').update(`${row.prev_hash ?? ''}|${row.org_id}|${row.id}|${row.event}|${JSON.stringify(row.payload ?? {})}|${row.created_at}`).digest('hex')
    }
    for (const same of UNIQUE[name] ?? []) {
      if (this.table(name).some((existing) => same(existing, row))) throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: UNIQUE_VIOLATION })
    }
    this.table(name).push(row)
    return row
  }

  from(name: string) {
    return new Builder(this, name)
  }

  rpc(name: string, args: Row = {}) {
    this.rpcCalls.push({ name, args: clone(args) })
    const handler = this.rpcHandlers[name]
    const result = handler ? handler(args, this) : { data: null, error: { message: `rpc ${name} is not emulated` } }
    return Promise.resolve(result)
  }

  /** The object `getSupabaseAdmin()` should return. */
  client() {
    return { from: (name: string) => this.from(name), rpc: (name: string, args?: Row) => this.rpc(name, args) }
  }
}

function parseCondition(text: string): Filter {
  const [column, op, ...rest] = text.split('.')
  const value = rest.join('.')
  const compare = (row: Row) => String(row[column as string] ?? '')
  switch (op) {
    case 'eq':
      return (row) => compare(row) === value
    case 'lt':
      return (row) => compare(row) < value
    case 'gt':
      return (row) => compare(row) > value
    default:
      throw new Error(`fake database: or() condition "${text}" is not supported`)
  }
}

function parseOr(expression: string): Filter {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of expression) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else current += char
  }
  parts.push(current)
  const filters = parts.map((part) => {
    const inner = /^and\((.*)\)$/.exec(part)
    if (!inner) return parseCondition(part)
    const conditions = (inner[1] as string).split(',').map(parseCondition)
    return (row: Row) => conditions.every((condition) => condition(row))
  })
  return (row) => filters.some((filter) => filter(row))
}

class Builder implements PromiseLike<Result> {
  private op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select'
  private filters: Filter[] = []
  private payload: Row | Row[] | null = null
  private conflict: string[] | null = null
  private orderBy: { column: string; ascending: boolean }[] = []
  private max: number | null = null
  private rangeFrom: number | null = null
  private returning = false
  private head = false
  private wantCount = false
  private selectText: string | undefined

  constructor(
    private readonly db: FakeDb,
    private readonly name: string,
  ) {}

  select(columns?: string, options?: { count?: string; head?: boolean }) {
    this.selectText = columns
    this.returning = true
    this.head = options?.head === true
    this.wantCount = options?.count !== undefined
    return this
  }
  insert(payload: Row | Row[]) {
    this.op = 'insert'
    this.payload = payload
    return this
  }
  upsert(payload: Row | Row[], options?: { onConflict?: string }) {
    this.op = 'upsert'
    this.payload = payload
    this.conflict = options?.onConflict?.split(',').map((column) => column.trim()) ?? ['id']
    return this
  }
  update(payload: Row) {
    this.op = 'update'
    this.payload = payload
    return this
  }
  delete() {
    this.op = 'delete'
    return this
  }

  eq(column: string, value: unknown) {
    this.filters.push((row) => valueAt(row, column) === value)
    return this
  }
  neq(column: string, value: unknown) {
    this.filters.push((row) => valueAt(row, column) !== value)
    return this
  }
  gt(column: string, value: any) {
    this.filters.push((row) => row[column] !== null && row[column] > value)
    return this
  }
  gte(column: string, value: any) {
    this.filters.push((row) => row[column] !== null && row[column] >= value)
    return this
  }
  lt(column: string, value: any) {
    this.filters.push((row) => row[column] !== null && row[column] < value)
    return this
  }
  lte(column: string, value: any) {
    this.filters.push((row) => row[column] !== null && row[column] <= value)
    return this
  }
  in(column: string, values: readonly unknown[]) {
    this.filters.push((row) => values.includes(valueAt(row, column)))
    return this
  }
  is(column: string, value: null | boolean) {
    this.filters.push((row) => (valueAt(row, column) ?? null) === value)
    return this
  }
  not(column: string, operator: string, value: unknown) {
    if (operator !== 'is') throw new Error('fake database: only not(..., "is", ...) is supported')
    this.filters.push((row) => (row[column] ?? null) !== value)
    return this
  }
  or(expression: string) {
    this.filters.push(parseOr(expression))
    return this
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.orderBy.push({ column, ascending: options?.ascending !== false })
    return this
  }
  limit(count: number) {
    this.max = count
    return this
  }
  range(from: number, to: number) {
    this.rangeFrom = from
    this.max = to - from + 1
    return this
  }

  async maybeSingle(): Promise<Result> {
    const result = this.run()
    const rows = (result.data ?? []) as Row[]
    return { data: rows[0] ?? null, error: result.error }
  }
  async single(): Promise<Result> {
    const result = this.run()
    const rows = (result.data ?? []) as Row[]
    if (!rows[0]) return { data: null, error: result.error ?? { message: 'no rows' } }
    return { data: rows[0], error: result.error }
  }
  then<T1 = Result, T2 = never>(resolve?: ((value: Result) => T1 | PromiseLike<T1>) | null, reject?: ((reason: unknown) => T2 | PromiseLike<T2>) | null): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(resolve, reject)
  }

  /** Rows with their embedded relations attached, when the select asked for any. */
  private withEmbeds(rows: Row[], name: string, embeds: Embed[]): Row[] {
    if (embeds.length === 0) return rows
    return rows.flatMap((row) => {
      const copy: Row = { ...row }
      for (const embed of embeds) {
        const relation = RELATIONS[name]?.[embed.name]
        if (!relation) throw new Error(`fake database: relation ${name}.${embed.name} is not registered`)
        const target = this.db.table(embed.name).find((candidate) => candidate.id === row[relation.foreignKey])
        if (!target) {
          if (embed.inner) return []
          copy[embed.name] = null
          continue
        }
        copy[embed.name] = this.withEmbeds([{ ...target }], embed.name, parseEmbeds(embed.nested))[0] ?? null
      }
      return [copy]
    })
  }

  private matching(): Row[] {
    const embeds = this.op === 'select' ? parseEmbeds(this.selectText) : []
    return this.withEmbeds(this.db.table(this.name), this.name, embeds).filter((row) => this.filters.every((filter) => filter(row)))
  }

  private run(): Result {
    try {
      return this.execute()
    } catch (error) {
      const known = error as { code?: string; message: string }
      return { data: null, error: { code: known.code, message: known.message } }
    }
  }

  private execute(): Result {
    const table = this.db.table(this.name)
    if (this.op === 'insert' || this.op === 'upsert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload as Row]
      const written: Row[] = []
      for (const input of rows) {
        if (this.op === 'upsert' && this.conflict) {
          const key = this.conflict
          const existing = table.find((row) => key.every((column) => row[column] === input[column]))
          if (existing) {
            Object.assign(existing, clone(input), { updated_at: nowIso() })
            written.push(existing)
            continue
          }
        }
        written.push(this.db.insertRow(this.name, input))
      }
      return { data: this.returning ? written.map(clone) : null, error: null }
    }
    if (this.op === 'update') {
      const rows = this.matching()
      for (const row of rows) Object.assign(row, clone(this.payload as Row), { updated_at: nowIso() })
      return { data: this.returning ? rows.map(clone) : null, error: null }
    }
    if (this.op === 'delete') {
      const rows = this.matching()
      this.db.tables.set(this.name, table.filter((row) => !rows.includes(row)))
      return { data: null, error: null }
    }

    let rows = this.matching()
    const total = rows.length
    for (const { column, ascending } of [...this.orderBy].reverse()) {
      rows = [...rows].sort((a, b) => (a[column] === b[column] ? 0 : (a[column] ?? '') < (b[column] ?? '') ? -1 : 1) * (ascending ? 1 : -1))
    }
    if (this.rangeFrom !== null) rows = rows.slice(this.rangeFrom)
    if (this.max !== null) rows = rows.slice(0, this.max)
    return { data: this.head ? null : rows.map(clone), error: null, count: this.wantCount ? total : null }
  }
}
