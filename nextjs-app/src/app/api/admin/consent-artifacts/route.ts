import { AppError } from '@/lib/api/errors'
import { paginationQuerySchema } from '@/lib/api/pagination'
import { created, ok, route } from '@/lib/api/route'
import { createConsentArtifactSchema, type CreateConsentArtifactInput } from '@/lib/validation/consent'
import { createConsentArtifact, listConsentArtifacts } from '@/server/services/consent/artifactService'
import type { ConsentArtifactView } from '@/types/consent'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Stub-ledger admin tools. Answers 404 unless CONSENT_MODE=stub. */
export const GET = route({
  roles: ['admin'],
  query: paginationQuerySchema,
  handler: async ({ user, query }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { artifacts, nextCursor } = await listConsentArtifacts(user, query)
    return ok(artifacts, { next_cursor: nextCursor })
  },
})

export const POST = route<ConsentArtifactView, CreateConsentArtifactInput>({
  roles: ['admin'],
  body: createConsentArtifactSchema,
  handler: async ({ user, body }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    return created(await createConsentArtifact(user, body))
  },
})
