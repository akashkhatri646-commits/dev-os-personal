import { z } from 'zod'
import { paginationQuerySchema } from '@/lib/api/pagination'
import { patientIdentifierSchema } from '@/lib/validation/patientIdentifier'
import { RECORD_STATUSES } from '@/types/domain'

/** ABDM health-information types a consent artifact can cover. */
export const DATA_CATEGORIES = [
  'DischargeSummary',
  'Prescription',
  'DiagnosticReport',
  'OPConsultation',
  'ImmunizationRecord',
  'HealthDocumentRecord',
  'WellnessRecord',
] as const
export type DataCategory = (typeof DATA_CATEGORIES)[number]

export const MAX_TEXT_CHARS = 200_000

export const submitIngestionSchema = z.object({
  source_id: z.uuid(),
  patient_identifier: patientIdentifierSchema,
  doc_type: z.enum(['discharge_summary', 'lab_report', 'other']),
  data_categories: z
    .array(z.enum(DATA_CATEGORIES))
    .min(1, 'Select at least one data category')
    .max(DATA_CATEGORIES.length)
    .default(['DischargeSummary']),
})
export type SubmitIngestionMeta = z.infer<typeof submitIngestionSchema>
export type SubmitIngestionFormInput = z.input<typeof submitIngestionSchema>

export const idempotencyKeySchema = z.string().trim().min(1).max(128)

/** JSON submission used by feed integrations: exactly one of `text` or `file_base64`. */
export const jsonSubmissionSchema = submitIngestionSchema
  .extend({
    text: z.string().max(MAX_TEXT_CHARS).optional(),
    file_base64: z.string().min(1).optional(),
    filename: z.string().max(200).optional(),
  })
  .refine((value) => (value.text === undefined) !== (value.file_base64 === undefined), {
    message: 'Provide exactly one of text or file_base64',
    path: ['text'],
  })

export const listRecordsQuerySchema = paginationQuerySchema.extend({
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(RECORD_STATUSES)).max(RECORD_STATUSES.length).optional()),
  source_id: z.uuid().optional(),
  record_id: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
})
export type ListRecordsQuery = z.infer<typeof listRecordsQuerySchema>

export const recordIdParamsSchema = z.object({ id: z.uuid() })

export const retryBodySchema = z.object({
  from_stage: z
    .enum(['consent_check', 'normalize', 'extract', 'map', 'validate', 'score', 'route'])
    .optional(),
})
export type RetryBody = z.infer<typeof retryBodySchema>
