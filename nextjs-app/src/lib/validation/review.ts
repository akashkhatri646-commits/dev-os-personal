import { z } from 'zod'
import { paginationQuerySchema } from '@/lib/api/pagination'

const FIELD_KEY = /^([a-z_]+)(?:\[(\d+)\])?\.([a-z_]+)$/

export const taskIdParamsSchema = z.object({ id: z.uuid() })

export const listReviewTasksQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['open', 'claimed', 'completed']).default('open'),
  kind: z.enum(['escalation', 'holdback_audit', 'downstream_error_review']).optional(),
  source_id: z.uuid().optional(),
  resource_type: z.string().min(1).max(40).optional(),
  mine: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
})
export type ListReviewTasksQuery = z.infer<typeof listReviewTasksQuerySchema>

const codeSchema = z.object({
  system: z.enum(['snomed', 'loinc', 'icd10']),
  code: z.string().trim().min(1).max(64),
})

export const reviewDecisionSchema = z.object({
  field_key: z.string().regex(FIELD_KEY),
  action: z.enum(['accept', 'correct', 'reject']),
  value: z.union([z.string().trim().min(1).max(2000), z.number().finite()]).optional(),
  code: codeSchema.nullable().optional(),
  note: z.string().trim().max(300).optional(),
})
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>

export const submitReviewBodySchema = z
  .object({
    decisions: z.array(reviewDecisionSchema).max(500),
    overall: z.enum(['approve', 'reject_record']),
    note: z.string().trim().max(300).optional(),
  })
  .superRefine((body, context) => {
    if (body.overall === 'reject_record' && !body.note) {
      context.addIssue({ code: 'custom', path: ['note'], message: 'A note is required to reject a record' })
    }
  })
export type SubmitReviewBody = z.infer<typeof submitReviewBodySchema>

export const reuploadBodySchema = z.object({ note: z.string().trim().min(1).max(300) })
export type ReuploadBody = z.infer<typeof reuploadBodySchema>

export const terminologySearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(120),
  system: z.enum(['snomed', 'loinc', 'icd10']),
  resource_type: z.string().min(1).max(40),
})
export type TerminologySearchQuery = z.infer<typeof terminologySearchQuerySchema>
