import { AppError } from '@/lib/api/errors'
import { accepted, ok, route } from '@/lib/api/route'
import { idempotencyKeySchema, listRecordsQuerySchema, type ListRecordsQuery } from '@/lib/validation/ingestion'
import { getRuntimeConfig } from '@/server/config/constants'
import { resolveIngestionPrincipal } from '@/server/services/ingestion/ingestionAuth'
import { listRecords, submitIngestion } from '@/server/services/ingestion/ingestionService'
import { parseSubmission } from '@/server/services/ingestion/parseSubmission'
import type { RecordSummary, SubmissionResult } from '@/types/records'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Submits a record: multipart upload from the UI, or JSON from a feed integration (`X-Source-Key`).
 * Answers 202 immediately; OCR and models run later in the worker. A repeat submission answers 200
 * with the original record id.
 */
export const POST = route<SubmissionResult>({
  // Authentication is custom (session OR source key) and done inside the handler.
  public: true,
  handler: async ({ req }) => {
    const principal = await resolveIngestionPrincipal(req)
    const parsed = await parseSubmission(req, getRuntimeConfig().maxUploadBytes)
    const rawKey = req.headers.get('idempotency-key')
    const idempotencyKey = rawKey ? idempotencyKeySchema.parse(rawKey) : null
    const result = await submitIngestion(principal, parsed, idempotencyKey)
    return result.duplicate ? ok(result) : accepted(result)
  },
})

export const GET = route<RecordSummary[], undefined, ListRecordsQuery>({
  roles: ['integration_engineer', 'reviewer', 'admin'],
  query: listRecordsQuerySchema,
  handler: async ({ user, query }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.')
    const { records, nextCursor } = await listRecords(user, query)
    return ok(records, { next_cursor: nextCursor })
  },
})
