import { FREQUENCIES, ROUTES, UNITS, type AttributeSpec, type EntitySpec } from '@/server/services/extraction/fieldCatalog'
import { CODEABLE_FIELDS } from '@/server/services/mapping/map'
import { fieldLabel } from '@/lib/review/labels'
import type { Coding } from '@/types/domain'
import type { ReviewKind, WorkspaceField, WorkspaceIssue, WorkspaceResource, WorkspaceSpan } from '@/types/review'

export interface WorkspaceResourceRow {
  id: string
  resource_type: string
  source_ref: string | null
  codings: readonly Coding[]
  flags: readonly string[]
  validation_status: 'pass' | 'fail' | 'pending'
  validation_issues: readonly WorkspaceIssue[]
}

export interface WorkspaceFieldRow {
  field_key: string
  found: boolean
  value: unknown
  source_span: Record<string, unknown> | null
  basis: 'stated' | 'inferred' | null
  model_confidence: number | null
}

export interface WorkspaceScoreRow {
  scope: 'field' | 'resource' | 'record'
  field_key: string | null
  resource_id: string | null
  score: number
  components: Record<string, unknown> | null
}

export interface WorkspaceInput {
  resources: readonly WorkspaceResourceRow[]
  fields: readonly WorkspaceFieldRow[]
  scores: readonly WorkspaceScoreRow[]
  thresholds: Record<string, { threshold: number }>
  catalog: readonly EntitySpec[]
}

const REF_PATTERN = /^([a-z_]+)(?:\[\d+\])?$/

/** Fixed-choice answers a reviewer can pick from, or null for free entry. */
export function choicesFor(attribute: AttributeSpec): readonly string[] | null {
  if (attribute.kind === 'enum') return attribute.values ?? null
  if (attribute.kind === 'frequency') return FREQUENCIES
  if (attribute.kind === 'route') return ROUTES
  if (attribute.kind === 'unit') return UNITS
  return null
}

function spanOf(raw: Record<string, unknown> | null): WorkspaceSpan | null {
  if (!raw) return null
  return {
    page: typeof raw.page === 'number' ? raw.page : 0,
    quote: typeof raw.quote === 'string' ? raw.quote : '',
    block_ids: Array.isArray(raw.block_ids) ? raw.block_ids.filter((id): id is string => typeof id === 'string') : [],
    char_start: typeof raw.char_start === 'number' ? raw.char_start : 0,
    char_end: typeof raw.char_end === 'number' ? raw.char_end : 0,
    ...(raw.manual === true ? { manual: true } : {}),
  }
}

function concernsOf(components: Record<string, unknown> | null | undefined): string[] {
  const caps = components?.caps_applied
  return Array.isArray(caps) ? caps.filter((cap): cap is string => typeof cap === 'string') : []
}

/**
 * The fields a reviewer sees for each resource: every value found for the entity plus any required
 * value the document lacks. A field needs an explicit decision when it scored below the resource's
 * threshold, was held down for any reason, or is a required value that is missing.
 */
export function buildWorkspaceResources(input: WorkspaceInput): WorkspaceResource[] {
  const fieldsByKey = new Map(input.fields.map((row) => [row.field_key, row]))
  const fieldScores = new Map(input.scores.filter((row) => row.scope === 'field').map((row) => [`${row.resource_id}|${row.field_key}`, row]))
  const resourceScores = new Map(input.scores.filter((row) => row.scope === 'resource').map((row) => [row.resource_id, row.score]))

  return input.resources.flatMap((resource) => {
    const entity = REF_PATTERN.exec(resource.source_ref ?? '')?.[1]
    const spec = entity ? input.catalog.find((candidate) => candidate.entity === entity) : undefined
    if (!entity || !spec || !resource.source_ref) return []

    const threshold = input.thresholds[resource.resource_type]?.threshold ?? null
    const fields: WorkspaceField[] = []
    for (const attribute of spec.attributes) {
      const key = `${resource.source_ref}.${attribute.name}`
      const row = fieldsByKey.get(key)
      const found = row?.found === true
      if (!found && !attribute.required) continue

      const scored = fieldScores.get(`${resource.id}|${key}`)
      const score = scored?.score ?? 0
      const concerns = found ? concernsOf(scored?.components) : ['missing_required']
      const codeable = CODEABLE_FIELDS.find((entry) => entry.entity === entity && entry.attribute === attribute.name)
      const coding = codeable ? resource.codings.find((entry) => entry.field_key === key) : undefined
      const value = found && (typeof row?.value === 'string' || typeof row?.value === 'number') ? row.value : null

      fields.push({
        field_key: key,
        label: fieldLabel(key),
        value,
        found,
        required: attribute.required,
        basis: row?.basis ?? null,
        confidence: row?.model_confidence ?? 0,
        score,
        concerns,
        needs_decision: !found || concerns.length > 0 || threshold === null || score < threshold,
        span: found ? spanOf(row?.source_span ?? null) : null,
        coding: coding
          ? { system: coding.system, code: coding.code, display: coding.display, match_confidence: coding.match_confidence, candidates: [...coding.candidates] }
          : null,
        codeable: codeable ? { system: codeable.primary, ...(codeable.secondary ? { secondary: codeable.secondary } : {}) } : null,
        kind: attribute.kind,
        choices: choicesFor(attribute),
      })
    }
    return [
      {
        id: resource.id,
        resource_type: resource.resource_type,
        validation_status: resource.validation_status,
        validation_issues: [...resource.validation_issues],
        score: resourceScores.get(resource.id) ?? null,
        threshold,
        flags: [...resource.flags],
        fields,
      },
    ]
  })
}

/** What a reviewer may see of the routing decision. A random audit sample must look like any escalation. */
export function visibleDecision(
  decision: { reasons: readonly string[]; reasoning_trace: string },
  kind: ReviewKind,
  isAdmin: boolean,
): { reasons: string[]; reasoning_trace: string } {
  if (isAdmin || kind !== 'holdback_audit') return { reasons: [...decision.reasons], reasoning_trace: decision.reasoning_trace }
  return {
    reasons: decision.reasons.filter((reason) => reason !== 'holdback'),
    reasoning_trace: decision.reasoning_trace.replace(/ Decision: [^.]*\./, '').trim(),
  }
}
