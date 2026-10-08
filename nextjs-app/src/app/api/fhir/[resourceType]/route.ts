import { AppError } from '@/lib/api/errors'
import { route } from '@/lib/api/route'
import { fhirSearchQuerySchema, type FhirSearchQuery } from '@/lib/validation/fhir'
import { fhirResponse, parseResourceType, searchFhirResources } from '@/server/services/fhir/fhirRead'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Search of committed resources by patient or record only (any other parameter is a 422). Returns a search-set bundle. */
export const GET = route<never, undefined, FhirSearchQuery, { resourceType: string }>({
  roles: ['integration_engineer', 'admin'],
  query: fhirSearchQuerySchema,
  handler: async ({ user, query, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const type = parseResourceType(params.resourceType)
    return fhirResponse(await searchFhirResources(user, type, { ...(query.patient ? { patient: query.patient } : {}), ...(query.record ? { record: query.record } : {}), count: query._count, page: query._page }))
  },
})
