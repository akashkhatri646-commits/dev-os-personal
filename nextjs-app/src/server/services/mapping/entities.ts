import { parseFieldKey } from '@/server/services/extraction/fieldCatalog'
import type { SourceSpan } from '@/types/domain'

/** A grounded value of one attribute, with where it came from. */
export interface FieldValue {
  value: string | number
  span: SourceSpan
  basis: 'stated' | 'inferred'
  confidence: number
}

/** All grounded attributes of one entity instance, e.g. `medication[0]`. */
export interface EntityInstance {
  entity: string
  index: number | null
  /** `medication[0]` or, for singleton entities, `encounter`. */
  ref: string
  attrs: Partial<Record<string, FieldValue>>
}

/** A row of `extracted_fields` as the mapping stage reads it. */
export interface StoredField {
  field_key: string
  found: boolean
  value: unknown
  source_span: SourceSpan | null
  basis: 'stated' | 'inferred' | null
  model_confidence: number | null
}

/** Groups the found, grounded fields into entity instances, in entity-then-index order. */
export function groupFields(rows: readonly StoredField[]): EntityInstance[] {
  const instances = new Map<string, EntityInstance>()
  for (const row of rows) {
    if (!row.found || !row.source_span || row.basis === null) continue
    if (typeof row.value !== 'string' && typeof row.value !== 'number') continue
    const parsed = parseFieldKey(row.field_key)
    if (!parsed) continue

    const ref = parsed.index === null ? parsed.entity : `${parsed.entity}[${parsed.index}]`
    const instance = instances.get(ref) ?? { entity: parsed.entity, index: parsed.index, ref, attrs: {} }
    instance.attrs[parsed.attribute] = {
      value: row.value,
      span: row.source_span,
      basis: row.basis,
      confidence: row.model_confidence ?? 0,
    }
    instances.set(ref, instance)
  }
  return [...instances.values()].sort((a, b) => a.entity.localeCompare(b.entity) || (a.index ?? 0) - (b.index ?? 0))
}
