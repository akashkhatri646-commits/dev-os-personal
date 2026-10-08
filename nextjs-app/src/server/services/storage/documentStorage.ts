import 'server-only'
import { AppError } from '@/lib/api/errors'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getEnv } from '@/server/config/env'

/** Storage layout: `{org_id}/{record_id}/{filename}` inside the private source-documents bucket. */
export function documentPath(orgId: string, recordId: string, filename: string): string {
  return `${orgId}/${recordId}/${filename}`
}

function bucket() {
  return getSupabaseAdmin().storage.from(getEnv().SUPABASE_STORAGE_BUCKET)
}

export async function uploadDocument(path: string, body: Buffer, contentType: string): Promise<void> {
  const { error } = await bucket().upload(path, body, { contentType, upsert: false })
  if (error) throw new AppError('INTERNAL', 'Failed to store the document.', { cause: error, retryable: true })
}

/** Best-effort removal used to undo an upload when the database write that follows it fails. */
export async function removeDocument(path: string): Promise<void> {
  await bucket().remove([path])
}

export async function downloadDocument(path: string): Promise<Buffer> {
  const { data, error } = await bucket().download(path)
  if (error || !data) throw new AppError('INTERNAL', 'The stored document could not be read.', { cause: error })
  return Buffer.from(await data.arrayBuffer())
}

/** Short-lived signed URL for viewing a stored document. */
export async function createSignedDocumentUrl(path: string, ttlSeconds: number): Promise<string> {
  const { data, error } = await bucket().createSignedUrl(path, ttlSeconds)
  if (error || !data) throw new AppError('INTERNAL', 'Could not create a document link.', { cause: error })
  return data.signedUrl
}
