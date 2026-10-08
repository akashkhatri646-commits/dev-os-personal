import 'server-only'
import { z } from 'zod'
import { AppError } from '@/lib/api/errors'
import { buildPage, cursorFilter, decodeCursor } from '@/lib/api/pagination'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import type {
  CreateConsentArtifactInput,
  UpdateConsentArtifactInput,
} from '@/lib/validation/consent'
import { getEnv } from '@/server/config/env'
import { appendAudit } from '@/server/services/audit/auditLog'
import { decryptIdentifier, fromBytea } from '@/server/services/patients/patientIdentifiers'
import { upsertPatient } from '@/server/services/patients/patientService'
import type { AuthUser } from '@/types/domain'
import type { ConsentArtifactView, EffectiveConsentStatus } from '@/types/consent'

const UNIQUE_VIOLATION = '23505'

const rowSchema = z.object({
  id: z.string(),
  artifact_ref: z.string(),
  categories: z.array(z.string()),
  valid_from: z.string(),
  valid_to: z.string(),
  status: z.enum(['granted', 'revoked', 'expired']),
  created_at: z.string(),
  patients: z.union([
    z.object({ org_id: z.string(), abha_enc: z.string().nullable(), mrn_enc: z.string().nullable() }),
    z.array(z.object({ org_id: z.string(), abha_enc: z.string().nullable(), mrn_enc: z.string().nullable() })),
  ]),
})
type Row = z.infer<typeof rowSchema>

const COLUMNS =
  'id, artifact_ref, categories, valid_from, valid_to, status, created_at, patients!inner(org_id, abha_enc, mrn_enc)'

/** The stub ledger is a QA tool: with the real ABDM ledger selected these routes do not exist. */
export function assertStubMode(): void {
  if (getEnv().CONSENT_MODE !== 'stub') throw new AppError('NOT_FOUND', 'Not found.')
}

function effectiveStatus(row: Pick<Row, 'status' | 'valid_from' | 'valid_to'>, now: Date): EffectiveConsentStatus {
  if (row.status === 'revoked') return 'revoked'
  if (row.status === 'expired' || new Date(row.valid_to) < now) return 'expired'
  if (new Date(row.valid_from) > now) return 'not_yet_valid'
  return 'valid'
}

/** `ABHA ••••1234`. The full identifier is never shown after it has been stored. */
function patientLabel(row: Row): string {
  const patient = Array.isArray(row.patients) ? row.patients[0] : row.patients
  const encrypted = patient?.abha_enc ?? patient?.mrn_enc
  if (!patient || !encrypted) return 'Unknown patient'
  try {
    const plain = decryptIdentifier(fromBytea(encrypted))
    return `${patient.abha_enc ? 'ABHA' : 'MRN'} ••••${plain.slice(-4)}`
  } catch {
    return 'Identifier unreadable'
  }
}

function toView(row: Row, now = new Date()): ConsentArtifactView {
  return {
    id: row.id,
    artifact_ref: row.artifact_ref,
    categories: row.categories,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    status: row.status,
    effective_status: effectiveStatus(row, now),
    patient_label: patientLabel(row),
    created_at: row.created_at,
  }
}

export async function listConsentArtifacts(
  actor: AuthUser,
  options: { limit: number; cursor?: string },
): Promise<{ artifacts: ConsentArtifactView[]; nextCursor: string | null }> {
  assertStubMode()
  let query = getSupabaseAdmin()
    .from('consent_artifacts')
    .select(COLUMNS)
    .eq('patients.org_id', actor.orgId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(options.limit + 1)
  if (options.cursor) query = query.or(cursorFilter(decodeCursor(options.cursor)))

  const { data, error } = await query
  if (error) throw new AppError('INTERNAL', 'Failed to load consent artifacts.', { cause: error })
  const { items, nextCursor } = buildPage(z.array(rowSchema).parse(data ?? []), options.limit)
  const now = new Date()
  return { artifacts: items.map((row) => toView(row, now)), nextCursor }
}

async function loadArtifact(actor: AuthUser, id: string): Promise<Row> {
  const { data, error } = await getSupabaseAdmin()
    .from('consent_artifacts')
    .select(COLUMNS)
    .eq('id', id)
    .eq('patients.org_id', actor.orgId)
    .maybeSingle()
  if (error) throw new AppError('INTERNAL', 'Failed to load the consent artifact.', { cause: error })
  if (!data) throw new AppError('NOT_FOUND', 'Consent artifact not found.')
  return rowSchema.parse(data)
}

export async function createConsentArtifact(
  actor: AuthUser,
  input: CreateConsentArtifactInput,
): Promise<ConsentArtifactView> {
  assertStubMode()
  const admin = getSupabaseAdmin()

  const { data: source, error: sourceError } = await admin
    .from('provider_sources')
    .select('id')
    .eq('id', input.source_id)
    .eq('org_id', actor.orgId)
    .maybeSingle()
  if (sourceError) throw new AppError('INTERNAL', 'Failed to load the source.', { cause: sourceError })
  if (!source) throw new AppError('NOT_FOUND', 'Source not found.')

  const patientId = await upsertPatient(actor.orgId, input.source_id, input.patient_identifier)
  const { data, error } = await admin
    .from('consent_artifacts')
    .insert({
      patient_id: patientId,
      artifact_ref: input.artifact_ref,
      regime: 'abdm',
      categories: input.categories,
      valid_from: input.valid_from,
      valid_to: input.valid_to,
      status: input.status,
    })
    .select('id')
    .single()
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      throw new AppError('CONFLICT', 'A consent artifact with this reference already exists.', {
        reason: 'ARTIFACT_REF_TAKEN',
      })
    }
    throw new AppError('INTERNAL', 'Failed to create the consent artifact.', { cause: error })
  }

  await appendAudit({
    orgId: actor.orgId,
    actor: { type: 'user', id: actor.userId },
    event: 'consent.artifact_created',
    payload: { artifact_id: data.id as string, status: input.status, categories: input.categories },
  })
  return toView(await loadArtifact(actor, data.id as string))
}

export async function updateConsentArtifact(
  actor: AuthUser,
  id: string,
  input: UpdateConsentArtifactInput,
): Promise<ConsentArtifactView> {
  assertStubMode()
  const existing = await loadArtifact(actor, id)
  const { error } = await getSupabaseAdmin().from('consent_artifacts').update({ status: input.status }).eq('id', id)
  if (error) throw new AppError('INTERNAL', 'Failed to update the consent artifact.', { cause: error })

  await appendAudit({
    orgId: actor.orgId,
    actor: { type: 'user', id: actor.userId },
    event: 'consent.artifact_updated',
    payload: { artifact_id: id, from: existing.status, to: input.status },
  })
  return toView(await loadArtifact(actor, id))
}
