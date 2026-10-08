import { z } from 'zod'
import { paginationQuerySchema } from '@/lib/api/pagination'

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
export const ROOT_CAUSES = ['extraction', 'mapping', 'ocr', 'threshold', 'consent', 'other'] as const

export const errorReportBodySchema = z.object({
  fhir_resource_id: z.uuid().optional(),
  description: z.string().trim().min(10, 'Describe the problem in at least 10 characters').max(1000),
  severity: z.enum(SEVERITIES),
})
export type ErrorReportBody = z.infer<typeof errorReportBodySchema>

export const listIncidentsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['open', 'investigating', 'resolved']).optional(),
})
export type ListIncidentsQuery = z.infer<typeof listIncidentsQuerySchema>

export const updateIncidentBodySchema = z
  .object({
    status: z.enum(['investigating', 'resolved']),
    root_cause: z.enum(ROOT_CAUSES).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .superRefine((body, context) => {
    if (body.status === 'resolved' && !body.root_cause) {
      context.addIssue({ code: 'custom', path: ['root_cause'], message: 'Choose a root cause to resolve the incident' })
    }
  })
export type UpdateIncidentBody = z.infer<typeof updateIncidentBodySchema>

export const bulkReviewBodySchema = z.object({
  record_ids: z.array(z.uuid()).min(1).max(500),
})
export type BulkReviewBody = z.infer<typeof bulkReviewBodySchema>

export const pauseAllBodySchema = z.object({
  reason: z.string().trim().min(5, 'Give a reason of at least 5 characters').max(300),
})
export type PauseAllBody = z.infer<typeof pauseAllBodySchema>

export const rollbackParamsSchema = z.object({ component: z.enum(['extraction', 'mapping']) })
export const rollbackBodySchema = z.object({ version: z.string().trim().min(1).max(64).optional() })
export type RollbackBody = z.infer<typeof rollbackBodySchema>
