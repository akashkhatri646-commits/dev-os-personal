import { AppError } from '@/lib/api/errors'
import { ok, route } from '@/lib/api/route'
import {
  consentArtifactIdParamsSchema,
  updateConsentArtifactSchema,
  type UpdateConsentArtifactInput,
} from '@/lib/validation/consent'
import { updateConsentArtifact } from '@/server/services/consent/artifactService'
import type { ConsentArtifactView } from '@/types/consent'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Revoke or re-grant an artifact to simulate a ledger change. Answers 404 unless CONSENT_MODE=stub. */
export const PATCH = route<ConsentArtifactView, UpdateConsentArtifactInput, undefined, { id: string }>({
  roles: ['admin'],
  body: updateConsentArtifactSchema,
  handler: async ({ user, body, params }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { id } = consentArtifactIdParamsSchema.parse(params)
    return ok(await updateConsentArtifact(user, id, body))
  },
})
