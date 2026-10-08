import { AppError } from '@/lib/api/errors'
import { route } from '@/lib/api/route'
import { fhirReadParamsSchema, fhirReadQuerySchema, type FhirReadQuery } from '@/lib/validation/fhir'
import { fhirResponse, parseResourceType, readFhirResource, readFhirWithProvenance } from '@/server/services/fhir/fhirRead'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Reads one committed resource as FHIR JSON. With `_include=Provenance` the answer is a search-set
 * bundle holding the resource and its Provenance. Authenticated users only; there is no external endpoint.
 */
export const GET = route<never, undefined, FhirReadQuery, { resourceType: string; id: string }>({
  roles: ['integration_engineer', 'reviewer', 'admin'],
  query: fhirReadQuerySchema,
  handler: async ({ user, query, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { resourceType, id } = fhirReadParamsSchema.parse(params)
    const type = parseResourceType(resourceType)
    return fhirResponse(query._include ? await readFhirWithProvenance(user, type, id) : await readFhirResource(user, type, id))
  },
})
