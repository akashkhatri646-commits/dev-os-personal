import { AppError } from '@/lib/api/errors'
import { route } from '@/lib/api/route'
import { fhirIdParamsSchema } from '@/lib/validation/fhir'
import { fhirResponse, readFhirProvenance } from '@/server/services/fhir/fhirRead'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The Provenance of a committed resource, addressed by the resource id. */
export const GET = route<never, undefined, undefined, { id: string }>({
  roles: ['integration_engineer', 'reviewer', 'admin'],
  handler: async ({ user, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    return fhirResponse(await readFhirProvenance(user, fhirIdParamsSchema.parse(params).id))
  },
})
