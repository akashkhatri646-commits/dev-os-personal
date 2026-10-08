import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { AppError } from '@/lib/api/errors'
import { parseSubmission } from '@/server/services/ingestion/parseSubmission'

const MAX = 1024
const SOURCE_ID = '3f2b8c1e-5c1a-4d6e-9c5e-2f7a1b0d9e12'

function multipart(fields: Record<string, string | string[] | File>, headers: Record<string, string> = {}) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const item of value) form.append(key, item)
    else form.set(key, value)
  }
  return new NextRequest('http://localhost/api/ingestions', { method: 'POST', body: form, headers })
}

const base = {
  source_id: SOURCE_ID,
  patient_identifier_type: 'abha',
  patient_identifier_value: '12-3456-7890-1234',
  doc_type: 'discharge_summary',
}

function json(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/ingestions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function catchError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    return error as AppError
  }
  throw new Error('expected rejection')
}

describe('parseSubmission (multipart)', () => {
  it('reads a file upload with validated metadata and a default data category', async () => {
    const request = multipart({ ...base, file: new File(['hello'], 'note.txt') })
    const parsed = await parseSubmission(request, MAX)
    expect(parsed.meta.patient_identifier).toEqual({ type: 'abha', value: '12-3456-7890-1234' })
    expect(parsed.meta.data_categories).toEqual(['DischargeSummary'])
    expect(parsed.content.kind).toBe('file')
    if (parsed.content.kind === 'file') {
      expect(parsed.content.bytes.toString()).toBe('hello')
      expect(parsed.content.filename).toBe('note.txt')
    }
  })

  it('reads inline text and explicit data categories', async () => {
    const request = multipart({ ...base, text: 'a note', data_categories: ['DischargeSummary', 'Prescription'] })
    const parsed = await parseSubmission(request, MAX)
    expect(parsed.content).toEqual({ kind: 'text', text: 'a note' })
    expect(parsed.meta.data_categories).toEqual(['DischargeSummary', 'Prescription'])
  })

  it('requires exactly one of file or text', async () => {
    expect((await catchError(parseSubmission(multipart(base), MAX))).reason).toBe('FILE_OR_TEXT')
    const both = multipart({ ...base, text: 'x', file: new File(['x'], 'a.txt') })
    expect((await catchError(parseSubmission(both, MAX))).reason).toBe('FILE_OR_TEXT')
  })

  it('rejects empty and oversized files and empty text', async () => {
    expect((await catchError(parseSubmission(multipart({ ...base, file: new File([], 'a.txt') }), MAX))).reason).toBe('EMPTY_CONTENT')
    const big = multipart({ ...base, file: new File([new Uint8Array(MAX + 1)], 'a.bin') })
    expect((await catchError(parseSubmission(big, MAX))).code).toBe('PAYLOAD_TOO_LARGE')
    expect((await catchError(parseSubmission(multipart({ ...base, text: '   ' }), MAX))).reason).toBe('EMPTY_CONTENT')
  })

  it('validates metadata: source id, ABHA format, categories', async () => {
    const badSource = multipart({ ...base, source_id: 'nope', text: 'x' })
    expect((await catchError(parseSubmission(badSource, MAX)) as unknown as Error).name).toBe('ZodError')
    const badAbha = multipart({ ...base, patient_identifier_value: '12', text: 'x' })
    expect((await catchError(parseSubmission(badAbha, MAX)) as unknown as Error).name).toBe('ZodError')
    const badCategory = multipart({ ...base, text: 'x', data_categories: ['Everything'] })
    expect((await catchError(parseSubmission(badCategory, MAX)) as unknown as Error).name).toBe('ZodError')
  })

  it('rejects a request whose declared size is far beyond the limit before reading it', async () => {
    const request = multipart({ ...base, text: 'x' }, { 'content-length': '1000000' })
    expect((await catchError(parseSubmission(request, MAX))).code).toBe('PAYLOAD_TOO_LARGE')
  })
})

describe('parseSubmission (json)', () => {
  const body = {
    source_id: SOURCE_ID,
    patient_identifier: { type: 'mrn', value: 'MRN-1' },
    doc_type: 'discharge_summary',
  }

  it('reads text submissions from feed integrations', async () => {
    const parsed = await parseSubmission(json({ ...body, text: 'a note' }), MAX)
    expect(parsed.content).toEqual({ kind: 'text', text: 'a note' })
    expect(parsed.meta.patient_identifier.type).toBe('mrn')
  })

  it('decodes base64 files and keeps the filename', async () => {
    const parsed = await parseSubmission(
      json({ ...body, file_base64: Buffer.from('%PDF-1.7').toString('base64'), filename: 'x.pdf' }),
      MAX,
    )
    expect(parsed.content.kind).toBe('file')
    if (parsed.content.kind === 'file') expect(parsed.content.bytes.toString()).toBe('%PDF-1.7')
  })

  it('rejects both or neither of text and file_base64', async () => {
    expect((await catchError(parseSubmission(json({ ...body }), MAX)) as unknown as Error).name).toBe('ZodError')
    const both = json({ ...body, text: 'a', file_base64: 'YQ==' })
    expect((await catchError(parseSubmission(both, MAX)) as unknown as Error).name).toBe('ZodError')
  })

  it('rejects an oversized decoded file and malformed JSON', async () => {
    const big = json({ ...body, file_base64: Buffer.alloc(MAX + 1).toString('base64') })
    expect((await catchError(parseSubmission(big, MAX))).code).toBe('PAYLOAD_TOO_LARGE')

    const broken = new NextRequest('http://localhost/api/ingestions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect((await catchError(parseSubmission(broken, MAX))).code).toBe('VALIDATION_FAILED')
  })
})

describe('parseSubmission (other content types)', () => {
  it('answers 415 for anything but multipart or JSON', async () => {
    const request = new NextRequest('http://localhost/api/ingestions', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x',
    })
    expect((await catchError(parseSubmission(request, MAX))).code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })
})
