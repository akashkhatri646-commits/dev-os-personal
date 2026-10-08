import { ok, route } from '@/lib/api/route'
import { terminologySearchQuerySchema, type TerminologySearchQuery } from '@/lib/validation/review'
import { searchCodes } from '@/server/services/review/reviewService'
import type { TerminologyHit } from '@/types/review'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Code lookup for the reviewer's code picker: reviewers choose from the terminology, never type a code. */
export const GET = route<TerminologyHit[], undefined, TerminologySearchQuery>({
  roles: ['reviewer', 'admin'],
  query: terminologySearchQuerySchema,
  handler: async ({ query }) => ok(await searchCodes(query)),
})
