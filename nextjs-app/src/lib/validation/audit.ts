import { z } from 'zod'
import { patientIdentifierSchema } from '@/lib/validation/patientIdentifier'
import { AUDIT_EVENTS } from '@/types/audit'

export const MAX_EXPORT_ROWS = 50_000

const isoDateTime = z.iso.datetime({ offset: true })

/** Filters shared by search and export. Sent as a JSON body so patient identifiers never enter URLs. */
export const auditFiltersSchema = z
  .object({
    record_id: z.uuid().optional(),
    source_id: z.uuid().optional(),
    patient_identifier: patientIdentifierSchema.optional(),
    events: z.array(z.enum(AUDIT_EVENTS)).max(20).optional(),
    actor_id: z.uuid().optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'Start must be before end',
    path: ['from'],
  })
export type AuditFilters = z.infer<typeof auditFiltersSchema>

export const auditSearchSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(64).optional(),
  })
  .and(auditFiltersSchema)
export type AuditSearchInput = z.infer<typeof auditSearchSchema>

export const auditExportSchema = z
  .object({ format: z.enum(['csv', 'json']) })
  .and(auditFiltersSchema)
export type AuditExportInput = z.infer<typeof auditExportSchema>
