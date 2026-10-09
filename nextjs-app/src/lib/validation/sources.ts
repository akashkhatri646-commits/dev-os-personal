import { z } from 'zod'
import { safeNote } from '@/lib/validation/phi'
import {
  THRESHOLD_MAX,
  THRESHOLD_MIN,
  THRESHOLD_RESOURCE_KEYS,
  thresholdFloor,
} from '@/lib/sources/rules'

export const providerTypeSchema = z.enum(['hospital', 'lab', 'clinic'])
export const sizeClassSchema = z.enum(['small', 'medium', 'large'])
export const docTypeSchema = z.enum(['discharge_summary', 'lab_report', 'other'])

const sourceNameSchema = z
  .string()
  .trim()
  .min(2, 'Name must be at least 2 characters')
  .max(80, 'Name must be at most 80 characters')

const languageSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2}$/, 'Use a two-letter ISO 639-1 code, e.g. en')

export const createSourceSchema = z.object({
  name: sourceNameSchema,
  provider_type: providerTypeSchema,
  size_class: sizeClassSchema,
  // An empty optional text input arrives as '' and means "not set".
  region: z
    .string()
    .trim()
    .max(80, 'Region must be at most 80 characters')
    .transform((value) => (value === '' ? undefined : value))
    .optional(),
  primary_language: languageSchema.default('en'),
  doc_types: z.array(docTypeSchema).min(1, 'Select at least one document type').max(3),
  consent_regime: z.enum(['abdm', 'hipaa']).default('abdm'),
})
export type CreateSourceInput = z.infer<typeof createSourceSchema>
export type CreateSourceFormInput = z.input<typeof createSourceSchema>

export const updateSourceSchema = z
  .object({
    name: sourceNameSchema.optional(),
    size_class: sizeClassSchema.optional(),
    region: z.string().trim().min(1).max(80).nullable().optional(),
    primary_language: languageSchema.optional(),
    doc_types: z.array(docTypeSchema).min(1).max(3).optional(),
    holdback_pct: z.number().min(0).max(100).optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'Provide at least one field to update',
  })
export type UpdateSourceInput = z.infer<typeof updateSourceSchema>

export const sourceIdParamsSchema = z.object({ id: z.uuid() })

export const setThresholdSchema = z
  .object({
    resource_type: z.enum(THRESHOLD_RESOURCE_KEYS),
    threshold: z
      .number()
      .min(THRESHOLD_MIN, `Threshold must be at least ${THRESHOLD_MIN}`)
      .max(THRESHOLD_MAX, `Threshold must be at most ${THRESHOLD_MAX}`),
    reason: safeNote(5),
  })
  .superRefine((value, context) => {
    const floor = thresholdFloor(value.resource_type)
    if (value.threshold < floor) {
      context.addIssue({
        code: 'custom',
        path: ['threshold'],
        message: `${value.resource_type} threshold cannot be below ${floor}`,
        params: { reason: 'THRESHOLD_TOO_LOW' },
      })
    }
  })
export type SetThresholdInput = z.infer<typeof setThresholdSchema>

export const noteBodySchema = z.object({ note: safeNote(5) })
export const reasonBodySchema = z.object({ reason: safeNote(5) })
export const flagPoorSchema = z.object({ note: safeNote(5) })

/** Query of the evaluation view: the period to look back over, in days (all time when omitted). */
export const evaluationQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(3650).optional(),
})

/** Body of "run evaluation": what kind of data the reviewed records are, so a pass is never shown without it. */
export const runEvaluationBodySchema = z.object({
  basis: z.enum(['synthetic', 'real']),
  note: z.string().trim().max(500).optional(),
})
