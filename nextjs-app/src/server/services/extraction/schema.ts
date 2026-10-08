import { z } from 'zod'
import { FIELD_KEY_PATTERN } from '@/server/services/extraction/fieldCatalog'
import { LlmSchemaError, type LlmSchema } from '@/types/llm'

const MAX_QUOTE_CHARS = 500
const MAX_FIELDS = 400
const MAX_NOTES_CHARS = 500

const sourceSchema = z.object({
  page: z.number().int().min(1),
  block_ids: z.array(z.string().min(1)).min(1),
  quote: z.string().min(1).max(MAX_QUOTE_CHARS),
})

const rawFieldSchema = z
  .object({
    field_key: z.string().regex(FIELD_KEY_PATTERN),
    /** Always text: numbers and dates are converted after grounding, using the field catalogue. */
    value: z.string().nullable(),
    found: z.boolean(),
    basis: z.enum(['stated', 'inferred']).nullable(),
    confidence: z.number().min(0).max(1),
    source: sourceSchema.nullable(),
  })
  .superRefine((field, context) => {
    if (field.found) {
      if (field.value === null || field.value.trim() === '') context.addIssue({ code: 'custom', path: ['value'], message: 'A found field needs a value' })
      if (field.source === null) context.addIssue({ code: 'custom', path: ['source'], message: 'A found field must cite its source' })
      if (field.basis === null) context.addIssue({ code: 'custom', path: ['basis'], message: 'A found field needs a basis' })
    } else {
      if (field.value !== null) context.addIssue({ code: 'custom', path: ['value'], message: 'A not-found field must have a null value' })
      if (field.source !== null) context.addIssue({ code: 'custom', path: ['source'], message: 'A not-found field must have a null source' })
    }
  })

export const extractionResultSchema = z.object({
  fields: z.array(rawFieldSchema).max(MAX_FIELDS),
  document_notes: z.string().max(MAX_NOTES_CHARS),
})

export type RawExtractionField = z.infer<typeof rawFieldSchema>
export type RawExtraction = z.infer<typeof extractionResultSchema>

const sourceJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['page', 'block_ids', 'quote'],
  properties: {
    page: { type: 'integer' },
    block_ids: { type: 'array', items: { type: 'string' } },
    quote: { type: 'string' },
  },
}

/**
 * JSON Schema sent to the provider. Written to satisfy OpenAI strict structured outputs: every
 * property is required, optional values are nullable, no extra keys, and no keywords beyond basic
 * types. The Zod schema above is the real validator; a test keeps the two in step.
 */
export const EXTRACTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['fields', 'document_notes'],
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field_key', 'value', 'found', 'basis', 'confidence', 'source'],
        properties: {
          field_key: { type: 'string' },
          value: { type: ['string', 'null'] },
          found: { type: 'boolean' },
          basis: { type: ['string', 'null'], enum: ['stated', 'inferred', null] },
          confidence: { type: 'number' },
          source: { anyOf: [sourceJsonSchema, { type: 'null' }] },
        },
      },
    },
    document_notes: { type: 'string' },
  },
}

function normalizeField(field: unknown): unknown {
  if (typeof field !== 'object' || field === null) return field
  const copy = { ...(field as Record<string, unknown>) }
  if (typeof copy.confidence === 'number') copy.confidence = Math.min(1, Math.max(0, copy.confidence))
  // A field the model says it did not find carries no value and no source, whatever it wrote there (an empty
  // string instead of null is the usual slip). Nothing it wrote for a missing field is used.
  if (copy.found === false) {
    copy.value = null
    copy.source = null
  }
  return copy
}

/**
 * Tidies harmless slips in the model's answer before it is validated: confidence outside 0 to 1 is clamped,
 * leftover text on a not-found field is dropped, and over-long notes are cut. Nothing that could change what a
 * found value says is touched: a found value with no value, no basis or no source still fails validation.
 */
export function normalizeExtraction(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const answer = raw as { fields?: unknown; document_notes?: unknown }
  return {
    ...answer,
    fields: Array.isArray(answer.fields) ? answer.fields.map(normalizeField) : answer.fields,
    document_notes: typeof answer.document_notes === 'string' ? answer.document_notes.slice(0, MAX_NOTES_CHARS) : answer.document_notes,
  }
}

export const EXTRACTION_SCHEMA: LlmSchema<RawExtraction> = {
  name: 'record_extraction',
  jsonSchema: EXTRACTION_JSON_SCHEMA,
  parse(raw: unknown): RawExtraction {
    const parsed = extractionResultSchema.safeParse(normalizeExtraction(raw))
    if (parsed.success) return parsed.data
    const detail = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new LlmSchemaError(detail)
  },
}
