import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { normalizePatientIdentifier, type PatientIdentifier } from '@/lib/validation/patientIdentifier'
import {
  encryptIdentifier,
  hashPatientIdentifier,
  toBytea,
} from '@/server/services/patients/patientIdentifiers'

const UNIQUE_VIOLATION = '23505'

/**
 * Finds or creates the patient row for an identifier. ABHA numbers are unique per organisation;
 * MRNs are unique per source. Only the HMAC hash and an AES-GCM ciphertext are stored.
 */
export async function upsertPatient(
  orgId: string,
  sourceId: string,
  identifier: PatientIdentifier,
): Promise<string> {
  const admin = getSupabaseAdmin()
  const hash = hashPatientIdentifier(identifier)
  const isAbha = identifier.type === 'abha'

  const find = async (): Promise<string | null> => {
    let query = admin.from('patients').select('id')
    query = isAbha
      ? query.eq('org_id', orgId).eq('abha_hash', hash)
      : query.eq('source_id', sourceId).eq('mrn_hash', hash)
    const { data, error } = await query.maybeSingle()
    if (error) throw new AppError('INTERNAL', 'Failed to look up the patient.', { cause: error })
    return (data?.id as string | undefined) ?? null
  }

  const existing = await find()
  if (existing) return existing

  const encrypted = toBytea(encryptIdentifier(normalizePatientIdentifier(identifier)))
  const { data, error } = await admin
    .from('patients')
    .insert({
      org_id: orgId,
      source_id: sourceId,
      ...(isAbha ? { abha_hash: hash, abha_enc: encrypted } : { mrn_hash: hash, mrn_enc: encrypted }),
    })
    .select('id')
    .single()

  if (error) {
    // A concurrent submission created the same patient first.
    if (error.code === UNIQUE_VIOLATION) {
      const raced = await find()
      if (raced) return raced
    }
    throw new AppError('INTERNAL', 'Failed to create the patient.', { cause: error })
  }
  return data.id as string
}
