import { z } from 'zod'

/** Only these parameters are supported; anything else is a 422, as the spec asks. */
export const fhirReadQuerySchema = z.object({ _include: z.literal('Provenance').optional() }).strict()
export type FhirReadQuery = z.infer<typeof fhirReadQuerySchema>

export const fhirSearchQuerySchema = z
  .object({
    patient: z.uuid().optional(),
    record: z.uuid().optional(),
    _count: z.coerce.number().int().min(1).max(100).default(25),
    _page: z.coerce.number().int().min(1).max(10_000).default(1),
  })
  .strict()
export type FhirSearchQuery = z.infer<typeof fhirSearchQuerySchema>

export const fhirReadParamsSchema = z.object({ resourceType: z.string().min(1).max(40), id: z.uuid() })
export const fhirIdParamsSchema = z.object({ id: z.uuid() })
