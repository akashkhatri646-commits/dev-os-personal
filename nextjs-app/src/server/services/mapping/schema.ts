import { z } from 'zod'
import { LlmSchemaError, type LlmSchema } from '@/types/llm'

const MAX_CHOICES = 100

const choiceSchema = z.object({
  field_key: z.string().min(1),
  /** The id of one offered candidate, or null when none fits. The model never writes a code. */
  candidate_id: z.string().nullable(),
  match_confidence: z.number().min(0).max(1),
  rationale: z.string().max(300),
})

export const mappingResultSchema = z.object({ choices: z.array(choiceSchema).max(MAX_CHOICES) })

export type MappingChoice = z.infer<typeof choiceSchema>
export type MappingResult = z.infer<typeof mappingResultSchema>

/** Written for OpenAI strict structured outputs; the Zod schema is the real validator and a test keeps them in step. */
export const MAPPING_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['choices'],
  properties: {
    choices: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field_key', 'candidate_id', 'match_confidence', 'rationale'],
        properties: {
          field_key: { type: 'string' },
          candidate_id: { type: ['string', 'null'] },
          match_confidence: { type: 'number' },
          rationale: { type: 'string' },
        },
      },
    },
  },
}

/**
 * Repairs harmless slips in a model answer before validating it: a confidence outside 0..1 is clamped and a
 * long rationale is cut. Structural problems (wrong types, missing fields) are still rejected.
 */
function normalizeMapping(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { choices?: unknown }).choices)) return raw
  const choices = (raw as { choices: unknown[] }).choices.slice(0, MAX_CHOICES).map((choice) => {
    if (typeof choice !== 'object' || choice === null) return choice
    const entry = { ...(choice as Record<string, unknown>) }
    if (typeof entry.match_confidence === 'number' && Number.isFinite(entry.match_confidence)) {
      entry.match_confidence = Math.min(1, Math.max(0, entry.match_confidence))
    }
    if (typeof entry.rationale === 'string') entry.rationale = entry.rationale.slice(0, 300)
    return entry
  })
  return { ...(raw as object), choices }
}

export const MAPPING_SCHEMA: LlmSchema<MappingResult> = {
  name: 'code_mapping',
  jsonSchema: MAPPING_JSON_SCHEMA,
  parse(raw: unknown): MappingResult {
    const parsed = mappingResultSchema.safeParse(normalizeMapping(raw))
    if (parsed.success) return parsed.data
    const detail = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new LlmSchemaError(detail)
  },
}
