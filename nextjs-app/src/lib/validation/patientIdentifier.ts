import { z } from 'zod'

/** ABHA number: 14 digits, hyphens optional (e.g. 12-3456-7890-1234). Normalised to 14 digits. */
const ABHA_PATTERN = /^\d{2}-?\d{4}-?\d{4}-?\d{4}$/
const MRN_PATTERN = /^[A-Za-z0-9\-_/.]{1,64}$/

export const patientIdentifierTypeSchema = z.enum(['abha', 'mrn'])
export type PatientIdentifierType = z.infer<typeof patientIdentifierTypeSchema>

export const patientIdentifierSchema = z
  .object({
    type: patientIdentifierTypeSchema,
    value: z.string().trim().min(1, 'Enter an identifier').max(64),
  })
  .superRefine((identifier, context) => {
    const pattern = identifier.type === 'abha' ? ABHA_PATTERN : MRN_PATTERN
    if (!pattern.test(identifier.value)) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message:
          identifier.type === 'abha'
            ? 'ABHA number must be 14 digits (hyphens allowed)'
            : 'MRN may use letters, digits and - _ / . (max 64 characters)',
        params: { reason: identifier.type === 'abha' ? 'ABHA_FORMAT' : 'MRN_FORMAT' },
      })
    }
  })
export type PatientIdentifier = z.infer<typeof patientIdentifierSchema>

/** Canonical form used for hashing and storage: ABHA as 14 digits, MRN trimmed as entered. */
export function normalizePatientIdentifier(identifier: PatientIdentifier): string {
  return identifier.type === 'abha' ? identifier.value.replaceAll('-', '') : identifier.value.trim()
}
