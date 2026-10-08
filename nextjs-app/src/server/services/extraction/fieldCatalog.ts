import type { DocType, ResourceType } from '@/types/domain'

/** How an attribute's value is checked against the quote it cites (see grounding.ts). */
export type AttributeKind =
  | 'text' // must appear in the quote
  | 'longtext' // a passage: most of its words must appear in the quote
  | 'number'
  | 'valueOrText' // lab results: a number, or a word such as "Positive"
  | 'date'
  | 'unit'
  | 'frequency'
  | 'route'
  | 'enum' // a classification chosen by the model; always treated as inferred

export interface AttributeSpec {
  name: string
  /** Required once the entity has any found attribute (docs/specs/06 §3: the ★ attributes). */
  required: boolean
  kind: AttributeKind
  /** Allowed values for `enum` attributes. */
  values?: readonly string[]
}

export interface EntitySpec {
  entity: string
  resourceType: ResourceType
  /** Several instances may appear (`diagnosis[0]`, `diagnosis[1]`, ...). */
  repeating: boolean
  attributes: readonly AttributeSpec[]
  /** Attribute identifying the instance, used to merge duplicates across chunks. */
  primary: string
  /**
   * Attribute every other attribute must sit next to in the text (the drug a dose belongs to, the
   * test a value belongs to). Prevents a value being cited from a different entity's line.
   */
  anchor?: string
}

const text = (name: string, required = false): AttributeSpec => ({ name, required, kind: 'text' })
const longtext = (name: string, required = false): AttributeSpec => ({ name, required, kind: 'longtext' })
const date = (name: string, required = false): AttributeSpec => ({ name, required, kind: 'date' })
const oneOf = (name: string, values: readonly string[], required = false): AttributeSpec => ({
  name,
  required,
  kind: 'enum',
  values,
})

/** Canonical dosing frequencies the model must answer with. */
export const FREQUENCIES = [
  'once daily',
  'twice daily',
  'three times daily',
  'four times daily',
  'at bedtime',
  'every 8 hours',
  'every 12 hours',
  'as needed',
  'weekly',
] as const

export const ROUTES = ['oral', 'intravenous', 'intramuscular', 'subcutaneous', 'topical', 'inhalation', 'sublingual', 'rectal', 'ophthalmic'] as const

export const UNITS = ['mg', 'mcg', 'g', 'ml', 'iu', 'unit', 'tablet', 'capsule', 'drop', 'puff'] as const

/** Field catalogue for discharge summaries (docs/specs/06-grounded-extraction.md §3). */
export const DISCHARGE_SUMMARY_CATALOG: readonly EntitySpec[] = [
  {
    entity: 'encounter',
    resourceType: 'Encounter',
    repeating: false,
    primary: 'admission_date',
    attributes: [
      date('admission_date', true),
      date('discharge_date', true),
      oneOf('class', ['inpatient', 'outpatient']),
      text('facility_name'),
      text('attending_practitioner'),
    ],
  },
  {
    entity: 'diagnosis',
    resourceType: 'Condition',
    repeating: true,
    primary: 'text',
    attributes: [
      text('text', true),
      oneOf('type', ['principal', 'secondary', 'comorbidity']),
      date('onset_date'),
      oneOf('status', ['active', 'resolved']),
    ],
  },
  {
    entity: 'medication',
    resourceType: 'MedicationRequest',
    repeating: true,
    primary: 'name',
    anchor: 'name',
    attributes: [
      text('name', true),
      { name: 'dose_value', required: true, kind: 'number' },
      { name: 'dose_unit', required: true, kind: 'unit' },
      { name: 'route', required: false, kind: 'route' },
      { name: 'frequency', required: true, kind: 'frequency' },
      text('duration'),
      longtext('instruction_text'),
      oneOf('phase', ['discharge', 'in_hospital']),
    ],
  },
  {
    entity: 'allergy',
    resourceType: 'AllergyIntolerance',
    repeating: true,
    primary: 'substance',
    anchor: 'substance',
    attributes: [text('substance', true), text('reaction'), oneOf('severity', ['mild', 'moderate', 'severe'])],
  },
  {
    entity: 'allergy_status',
    resourceType: 'AllergyIntolerance',
    repeating: false,
    primary: 'value',
    attributes: [oneOf('value', ['no_known_allergies'], true)],
  },
  {
    entity: 'lab',
    resourceType: 'Observation',
    repeating: true,
    primary: 'test_name',
    anchor: 'test_name',
    attributes: [
      text('test_name', true),
      { name: 'value', required: true, kind: 'valueOrText' },
      text('unit'),
      text('reference_range'),
      oneOf('interpretation', ['low', 'normal', 'high', 'abnormal']),
      date('collected_date'),
    ],
  },
  {
    entity: 'procedure',
    resourceType: 'Procedure',
    repeating: true,
    primary: 'name',
    attributes: [text('name', true), date('date')],
  },
  {
    entity: 'report',
    resourceType: 'DiagnosticReport',
    repeating: false,
    primary: 'title',
    attributes: [text('title', true), longtext('summary_text')],
  },
]

export function catalogFor(docType: DocType): readonly EntitySpec[] {
  // Lab reports (MVP 1) add their own catalogue; until then only discharge summaries are extracted.
  return docType === 'discharge_summary' ? DISCHARGE_SUMMARY_CATALOG : DISCHARGE_SUMMARY_CATALOG
}

/** `medication[0].dose_value` -> entity `medication`, index 0, attribute `dose_value`. */
export const FIELD_KEY_PATTERN = /^([a-z_]+)(?:\[(\d+)\])?\.([a-z_]+)$/

export interface ParsedFieldKey {
  entity: string
  index: number | null
  attribute: string
}

export function parseFieldKey(key: string): ParsedFieldKey | null {
  const match = FIELD_KEY_PATTERN.exec(key)
  if (!match?.[1] || !match[3]) return null
  return { entity: match[1], index: match[2] === undefined ? null : Number(match[2]), attribute: match[3] }
}

export function formatFieldKey(entity: string, index: number | null, attribute: string): string {
  return index === null ? `${entity}.${attribute}` : `${entity}[${index}].${attribute}`
}

export interface ResolvedField {
  entity: EntitySpec
  attribute: AttributeSpec
  parsed: ParsedFieldKey
}

/** Looks a field key up in the catalogue; null for anything the catalogue does not define. */
export function resolveField(catalog: readonly EntitySpec[], key: string): ResolvedField | null {
  const parsed = parseFieldKey(key)
  if (!parsed) return null
  const entity = catalog.find((candidate) => candidate.entity === parsed.entity)
  if (!entity) return null
  // Repeating entities need an index; singletons must not have one.
  if (entity.repeating !== (parsed.index !== null)) return null
  const attribute = entity.attributes.find((candidate) => candidate.name === parsed.attribute)
  return attribute ? { entity, attribute, parsed } : null
}
