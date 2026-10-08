import 'server-only'
import type { NextRequest } from 'next/server'
import { AppError } from '@/lib/api/errors'
import {
  MAX_TEXT_CHARS,
  jsonSubmissionSchema,
  submitIngestionSchema,
  type SubmitIngestionMeta,
} from '@/lib/validation/ingestion'

export type SubmissionContent =
  | { kind: 'file'; bytes: Buffer; filename: string | null }
  | { kind: 'text'; text: string }

export interface ParsedSubmission {
  meta: SubmitIngestionMeta
  content: SubmissionContent
}

/** JSON bodies carry base64, which is about a third larger than the file it encodes. */
const BASE64_OVERHEAD = 1.4
const ENVELOPE_ALLOWANCE_BYTES = 64 * 1024

function tooLarge(maxBytes: number): AppError {
  return new AppError('PAYLOAD_TOO_LARGE', `The upload is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`)
}

/** Rejects oversized requests from the Content-Length header before the body is read. */
function assertDeclaredSize(request: NextRequest, maxBytes: number): void {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes * BASE64_OVERHEAD + ENVELOPE_ALLOWANCE_BYTES) {
    throw tooLarge(maxBytes)
  }
}

function emptyContent(): AppError {
  return new AppError('VALIDATION_FAILED', 'The submitted file or text is empty.', { reason: 'EMPTY_CONTENT' })
}

/**
 * Reads a submission from `multipart/form-data` (browser upload) or `application/json` (feed
 * integration) into one validated shape. Size limits are enforced before and after reading.
 */
export async function parseSubmission(request: NextRequest, maxBytes: number): Promise<ParsedSubmission> {
  assertDeclaredSize(request, maxBytes)
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase()

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => {
      throw new AppError('VALIDATION_FAILED', 'The upload could not be read.')
    })
    const meta = submitIngestionSchema.parse({
      source_id: form.get('source_id'),
      patient_identifier: {
        type: form.get('patient_identifier_type'),
        value: form.get('patient_identifier_value'),
      },
      doc_type: form.get('doc_type'),
      data_categories: form.getAll('data_categories').length > 0 ? form.getAll('data_categories') : undefined,
    })

    const file = form.get('file')
    const text = form.get('text')
    if ((file instanceof File) === (typeof text === 'string')) {
      throw new AppError('VALIDATION_FAILED', 'Provide exactly one of file or text.', { reason: 'FILE_OR_TEXT' })
    }
    if (file instanceof File) {
      if (file.size === 0) throw emptyContent()
      if (file.size > maxBytes) throw tooLarge(maxBytes)
      return { meta, content: { kind: 'file', bytes: Buffer.from(await file.arrayBuffer()), filename: file.name } }
    }
    return { meta, content: textContent(String(text)) }
  }

  if (contentType.includes('application/json')) {
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      throw new AppError('VALIDATION_FAILED', 'Request body is not valid JSON.')
    }
    const body = jsonSubmissionSchema.parse(raw)
    const meta = submitIngestionSchema.parse(body)
    if (body.file_base64 !== undefined) {
      const bytes = Buffer.from(body.file_base64, 'base64')
      if (bytes.length === 0) throw emptyContent()
      if (bytes.length > maxBytes) throw tooLarge(maxBytes)
      return { meta, content: { kind: 'file', bytes, filename: body.filename ?? null } }
    }
    return { meta, content: textContent(body.text ?? '') }
  }

  throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be multipart/form-data or application/json.')
}

function textContent(text: string): SubmissionContent {
  if (text.trim().length === 0) throw emptyContent()
  if (text.length > MAX_TEXT_CHARS) {
    throw new AppError('PAYLOAD_TOO_LARGE', `Text is longer than ${MAX_TEXT_CHARS.toLocaleString('en')} characters.`)
  }
  return { kind: 'text', text }
}
