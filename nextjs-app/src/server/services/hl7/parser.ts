import { AppError } from '@/lib/api/errors'
import type { NormalizedPage } from '@/types/documents'

/** Batch/file envelope segments that never carry clinical content. */
const ENVELOPE_SEGMENTS = new Set(['FHS', 'BHS', 'BTS', 'FTS'])
const DEFAULT_ENCODING_CHARS = '^~\\&'

export interface Hl7ParseResult {
  pages: NormalizedPage[]
  warnings: string[]
  version: string | null
}

/** Strips MLLP framing bytes and normalises every line ending to a carriage return. */
export function normalizeHl7Text(raw: string): string {
  return raw
    .replace(/^﻿/, '')
    .replaceAll('\u000b', '')
    .replaceAll('\u001c', '')
    .replace(/\r\n|\n|\r/g, '\r')
    .trim()
}

/**
 * True when the text looks like an HL7 v2 message or batch: after framing and whitespace are removed
 * and any leading FHS/BHS envelope segments are skipped, the first segment must be `MSH`.
 */
export function looksLikeHl7(raw: string): boolean {
  const segments = normalizeHl7Text(raw).split('\r')
  const first = segments.find((segment) => !/^(FHS|BHS)[^\r\n]/.test(segment))
  return first !== undefined && /^MSH[^\r\n]/.test(first)
}

/**
 * Splits a payload holding several messages (e.g. wrapped in FHS/BHS) into one string per message.
 * Each message starts at an `MSH` segment; envelope segments are dropped.
 */
export function splitHl7Messages(raw: string): string[] {
  const messages: string[] = []
  let current: string[] = []
  for (const segment of normalizeHl7Text(raw).split('\r')) {
    if (segment.length === 0) continue
    const name = segment.slice(0, 3)
    if (ENVELOPE_SEGMENTS.has(name)) continue
    if (name === 'MSH' && current.length > 0) {
      messages.push(current.join('\r'))
      current = []
    }
    current.push(segment)
  }
  if (current.length > 0) messages.push(current.join('\r'))
  return messages
}

/** Resolves HL7 escape sequences (\F\ \S\ \T\ \R\ \E\ \.br\ \Xhh\) using the message's own delimiters. */
export function unescapeHl7(value: string, fieldSep: string, encoding: string): string {
  const [componentSep = '^', repetitionSep = '~', escapeChar = '\\', subComponentSep = '&'] = encoding.split('')
  if (!value.includes(escapeChar)) return value

  let result = ''
  let index = 0
  while (index < value.length) {
    const char = value[index]
    if (char !== escapeChar) {
      result += char
      index += 1
      continue
    }
    const end = value.indexOf(escapeChar, index + 1)
    if (end === -1) {
      result += value.slice(index)
      break
    }
    const code = value.slice(index + 1, end)
    index = end + 1
    if (code === 'F') result += fieldSep
    else if (code === 'S') result += componentSep
    else if (code === 'T') result += subComponentSep
    else if (code === 'R') result += repetitionSep
    else if (code === 'E') result += escapeChar
    else if (code === '.br') result += '\n'
    else if (/^X([0-9A-Fa-f]{2})+$/.test(code)) {
      const pairs = code.slice(1).match(/.{2}/g) ?? []
      result += pairs.map((pair) => String.fromCharCode(Number.parseInt(pair, 16))).join('')
    }
    // Formatting codes such as \H\ \N\ \Zxx\ carry no text and are dropped.
  }
  return result
}

/**
 * Flattens one HL7 v2 message into citeable text without any per-sender mapping: one block per
 * segment (id `SEG<n>`), one line per non-empty field as `<SEG>-<n>: <value>`. Unknown Z-segments
 * are kept verbatim, so non-standard feeds need no code changes.
 */
export function parseHl7(raw: string): Hl7ParseResult {
  const text = normalizeHl7Text(raw)
  const warnings: string[] = []
  const segments = text.split('\r').filter((segment) => segment.length > 0)
  const header = segments[0]

  if (!header || !header.startsWith('MSH') || header.length < 4) {
    throw new AppError('VALIDATION_FAILED', 'The payload is not a valid HL7 v2 message (missing MSH segment).', {
      reason: 'HL7_INVALID',
    })
  }

  const fieldSep = header.charAt(3)
  const encodingEnd = header.indexOf(fieldSep, 4)
  const encoding = (encodingEnd === -1 ? header.slice(4) : header.slice(4, encodingEnd)) || DEFAULT_ENCODING_CHARS
  if (encoding.length < 4) warnings.push('short_encoding_characters')

  let version: string | null = null
  const blocks = segments.map((segment, position) => {
    const name = segment.slice(0, 3)
    if (!/^[A-Z][A-Z0-9]{2}$/.test(name) || (segment.length > 3 && segment.charAt(3) !== fieldSep)) {
      warnings.push(`truncated_segment_${position + 1}`)
    }

    const rawFields = segment.split(fieldSep)
    // For MSH the separator itself is MSH-1, so real fields start at index 1 -> MSH-2.
    const fields = name === 'MSH' ? [fieldSep, ...rawFields.slice(1)] : rawFields.slice(1)
    if (name === 'MSH') version = fields[11] ? unescapeHl7(fields[11], fieldSep, encoding).split(encoding.charAt(0))[0] ?? null : null

    const lines: string[] = []
    fields.forEach((field, fieldIndex) => {
      if (field === '' || (name === 'MSH' && fieldIndex === 0)) return
      lines.push(`${name}-${fieldIndex + 1}: ${unescapeHl7(field, fieldSep, encoding)}`)
    })
    return { id: `SEG${position + 1}`, text: [name, ...lines].join('\n'), confidence: 1 }
  })

  if (version === null || !/^2\./.test(version)) warnings.push('unknown_version')

  return {
    pages: [{ page: 1, text: blocks.map((block) => block.text).join('\n'), blocks }],
    warnings,
    version,
  }
}
