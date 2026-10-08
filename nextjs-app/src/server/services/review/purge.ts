import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { appendAudit } from '@/server/services/audit/auditLog'
import { removeDocument } from '@/server/services/storage/documentStorage'

function fail(message: string, cause: unknown): never {
  throw new AppError('INTERNAL', message, { cause, retryable: true })
}

/**
 * Removes everything extracted from a record's document when consent is withdrawn before commit:
 * extracted values, draft resources, scores, the recognised text and the stored file. The record row,
 * routing decision and audit trail stay (they hold no health data). Safe to run again.
 */
export async function purgeRecordPHI(orgId: string, recordId: string): Promise<void> {
  const admin = getSupabaseAdmin()

  const { data: documents, error: documentError } = await admin.from('documents').select('id, storage_path').eq('record_id', recordId)
  if (documentError) fail('Failed to load the stored document.', documentError)

  for (const table of ['extracted_fields', 'mapped_resources', 'field_scores'] as const) {
    const { error } = await admin.from(table).delete().eq('record_id', recordId)
    if (error) fail(`Failed to purge ${table.replaceAll('_', ' ')}.`, error)
  }

  for (const document of documents ?? []) {
    const { error } = await admin.from('documents').update({ normalized_text: null }).eq('id', document.id)
    if (error) fail('Failed to purge the document text.', error)
    await removeDocument(document.storage_path as string)
  }

  await appendAudit({ orgId, recordId, actor: { type: 'system' }, event: 'record.phi_purged', payload: { documents: (documents ?? []).length } })
}
