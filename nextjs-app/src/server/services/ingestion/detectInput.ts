import { AppError } from '@/lib/api/errors'
import { looksLikeHl7 } from '@/server/services/hl7/parser'
import type { InputKind } from '@/types/domain'

export interface DetectedInput {
  kind: InputKind
  /** MIME type derived from the content itself, never from what the client declared. */
  mimeType: string
}

const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
  signature.every((value, index) => bytes[index] === value)

/**
 * Identifies an uploaded file by its magic bytes. The declared MIME type and file extension are
 * ignored: a mismatch with the content is simply not trusted (spec 03 §2).
 */
export function detectFileKind(bytes: Uint8Array): DetectedInput {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: 'pdf', mimeType: 'application/pdf' }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mimeType: 'image/png' }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: 'image', mimeType: 'image/jpeg' }
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { kind: 'image', mimeType: 'image/tiff' }
  }

  // Remaining candidates are text: HL7 messages and clinical notes. Reject binary content.
  const sample = bytes.subarray(0, 4096)
  if (sample.includes(0)) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Unsupported file type. Upload a PDF, PNG, JPEG, TIFF, HL7 or text file.')
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return detectTextKind(text)
}

/** Text is HL7v2 when it starts with an MSH segment, otherwise a free-text note. */
export function detectTextKind(text: string): DetectedInput {
  return looksLikeHl7(text) ? { kind: 'hl7v2', mimeType: 'text/plain' } : { kind: 'text', mimeType: 'text/plain' }
}
