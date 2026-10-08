import { z } from 'zod'
import { DATA_CATEGORIES } from '@/lib/validation/ingestion'
import { patientIdentifierSchema } from '@/lib/validation/patientIdentifier'

const isoDateTime = z.iso.datetime({ offset: true })

/** Seeds one consent artifact in the stub ledger (admin QA tool; unavailable when CONSENT_MODE=abdm). */
export const createConsentArtifactSchema = z
  .object({
    source_id: z.uuid(),
    patient_identifier: patientIdentifierSchema,
    artifact_ref: z
      .string()
      .trim()
      .min(1, 'Enter a consent reference')
      .max(128)
      .regex(/^[A-Za-z0-9._:/-]+$/, 'Use letters, digits and . _ : / - only'),
    categories: z.array(z.enum(DATA_CATEGORIES)).min(1, 'Select at least one category'),
    valid_from: isoDateTime,
    valid_to: isoDateTime,
    status: z.enum(['granted', 'revoked']).default('granted'),
  })
  .refine((value) => value.valid_to > value.valid_from, {
    message: 'The end must be after the start',
    path: ['valid_to'],
  })
export type CreateConsentArtifactInput = z.infer<typeof createConsentArtifactSchema>
export type CreateConsentArtifactFormInput = z.input<typeof createConsentArtifactSchema>

/** Simulates a ledger change: revoke an artifact or grant it again. */
export const updateConsentArtifactSchema = z.object({ status: z.enum(['granted', 'revoked']) })
export type UpdateConsentArtifactInput = z.infer<typeof updateConsentArtifactSchema>

export const consentArtifactIdParamsSchema = z.object({ id: z.uuid() })
