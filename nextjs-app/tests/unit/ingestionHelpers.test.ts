import { describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { AppError } from '@/lib/api/errors'
import { isRetryable, reasonLabel } from '@/lib/records/reasons'
import { detectFileKind, detectTextKind } from '@/server/services/ingestion/detectInput'
import { sanitizeFilename } from '@/server/services/ingestion/filename'

vi.mock('@/server/config/env', () => ({
  requireEnvValue: () => 'unused',
  getEnv: () => ({}),
}))

import {
  decryptIdentifier,
  encryptIdentifier,
  fromBytea,
  toBytea,
} from '@/server/services/patients/patientIdentifiers'

const bytes = (...values: number[]) => Uint8Array.from(values)

describe('detectFileKind (magic bytes, never the client-declared type)', () => {
  it('detects PDF, PNG, JPEG and TIFF', () => {
    expect(detectFileKind(Buffer.from('%PDF-1.7 ...')).kind).toBe('pdf')
    expect(detectFileKind(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)).mimeType).toBe('image/png')
    expect(detectFileKind(bytes(0xff, 0xd8, 0xff, 0xe0)).mimeType).toBe('image/jpeg')
    expect(detectFileKind(bytes(0x49, 0x49, 0x2a, 0x00)).mimeType).toBe('image/tiff')
    expect(detectFileKind(bytes(0x4d, 0x4d, 0x00, 0x2a)).mimeType).toBe('image/tiff')
  })

  it('treats HL7 and plain text as text kinds', () => {
    expect(detectFileKind(Buffer.from('MSH|^~\\&|A|B|C|D|2026||ADT^A01|1|P|2.5')).kind).toBe('hl7v2')
    expect(detectFileKind(Buffer.from('Discharge note: patient stable.')).kind).toBe('text')
  })

  it('rejects binary content such as an executable renamed to .pdf', () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.from([0, 0, 0, 1, 2, 3])])
    expect(() => detectFileKind(exe)).toThrow(AppError)
    try {
      detectFileKind(exe)
    } catch (error) {
      expect((error as AppError).code).toBe('UNSUPPORTED_MEDIA_TYPE')
    }
  })

  it('classifies pasted text', () => {
    expect(detectTextKind('MSH|^~\\&|A').kind).toBe('hl7v2')
    expect(detectTextKind('free text').kind).toBe('text')
  })

  it('accepts a PDF produced by a real library', async () => {
    const document = await PDFDocument.create()
    document.addPage()
    expect(detectFileKind(await document.save()).kind).toBe('pdf')
  })
})

describe('sanitizeFilename', () => {
  it('drops path components and unsafe characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('C:\\Users\\me\\scan 1 (final).pdf')).toBe('scan_1__final_.pdf')
    expect(sanitizeFilename('..hidden.pdf')).toBe('hidden.pdf')
  })

  it('falls back to "document" and bounds the length', () => {
    expect(sanitizeFilename(null)).toBe('document')
    expect(sanitizeFilename('')).toBe('document')
    expect(sanitizeFilename('....')).toBe('document')
    expect(sanitizeFilename(`${'a'.repeat(300)}.pdf`)).toHaveLength(100)
  })
})

describe('patient identifier encryption', () => {
  const key = Buffer.alloc(32, 7).toString('base64')

  it('round-trips and uses a fresh IV each time', () => {
    const first = encryptIdentifier('12345678901234', key)
    const second = encryptIdentifier('12345678901234', key)
    expect(first.equals(second)).toBe(false)
    expect(decryptIdentifier(first, key)).toBe('12345678901234')
    expect(first.toString('utf8')).not.toContain('12345678901234')
  })

  it('detects tampering and wrong keys', () => {
    const encrypted = encryptIdentifier('MRN-1', key)
    const tampered = Buffer.from(encrypted)
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff
    expect(() => decryptIdentifier(tampered, key)).toThrow()
    expect(() => decryptIdentifier(encrypted, Buffer.alloc(32, 9).toString('base64'))).toThrow()
  })

  it('refuses a key that is not 32 bytes', () => {
    expect(() => encryptIdentifier('x', Buffer.alloc(16).toString('base64'))).toThrow(AppError)
  })

  it('converts to and from the bytea wire format', () => {
    const buffer = Buffer.from([0, 1, 254, 255])
    expect(toBytea(buffer)).toBe('\\x0001feff')
    expect(fromBytea('\\x0001feff').equals(buffer)).toBe(true)
  })
})

describe('record reasons', () => {
  it('gives plain-language labels', () => {
    expect(reasonLabel('low_ocr_quality')).toContain('scan quality')
    expect(reasonLabel('stage_error:extract')).toBe('Processing stopped at the extract step')
    expect(reasonLabel('some_new_code')).toBe('some new code')
    expect(reasonLabel(null)).toBeNull()
  })

  it('mirrors the server retry rule', () => {
    expect(isRetryable('failed', 'consent_service_error')).toBe(true)
    expect(isRetryable('needs_review', 'llm_error')).toBe(true)
    expect(isRetryable('needs_review', 'stage_error:map')).toBe(true)
    expect(isRetryable('needs_review', 'ocr_unavailable')).toBe(true)
    expect(isRetryable('needs_review', 'llm_unavailable')).toBe(true)
    // A new file is needed for these, so retrying is pointless.
    expect(isRetryable('needs_review', 'unreadable_document')).toBe(false)
    expect(isRetryable('needs_review', 'handwriting')).toBe(false)
    expect(isRetryable('needs_review', 'language_unsupported')).toBe(false)
    expect(isRetryable('needs_review', 'below_threshold')).toBe(false)
    expect(isRetryable('committed', null)).toBe(false)
  })
})
