import { describe, expect, it } from 'vitest'
import { AppError } from '@/lib/api/errors'
import {
  looksLikeHl7,
  normalizeHl7Text,
  parseHl7,
  splitHl7Messages,
  unescapeHl7,
} from '@/server/services/hl7/parser'

const MESSAGE = [
  'MSH|^~\\&|LAB|CITY|EHR|CITY|202610071200||ORU^R01|MSG001|P|2.5.1',
  'PID|1||MRN123^^^CITY||Doe^Jane||19800101|F',
  'OBX|1|NM|2345-7^Glucose^LN||182|mg/dL|70-99|H',
  'ZXX|1|custom vendor field|second',
].join('\r')

const ENVELOPE = ['FHS|^~\\&', 'BHS|^~\\&']

describe('HL7 detection and framing', () => {
  it('recognises HL7 messages and rejects other text', () => {
    expect(looksLikeHl7(MESSAGE)).toBe(true)
    expect(looksLikeHl7('Patient seen today for fever.')).toBe(false)
    expect(looksLikeHl7('MSHxyz')).toBe(true)
    expect(looksLikeHl7('')).toBe(false)
  })

  it('recognises a batch that starts with FHS/BHS envelope segments', () => {
    expect(looksLikeHl7([...ENVELOPE, MESSAGE].join('\r'))).toBe(true)
    expect(looksLikeHl7([...ENVELOPE, 'PID|1'].join('\r'))).toBe(false)
  })

  it('strips MLLP framing and normalises line endings', () => {
    const framed = `\u000b${MESSAGE.replaceAll('\r', '\n')}\u001c\r`
    expect(normalizeHl7Text(framed)).toBe(MESSAGE)
    expect(normalizeHl7Text(MESSAGE.replaceAll('\r', '\r\n'))).toBe(MESSAGE)
  })
})

describe('parseHl7', () => {
  it('flattens segments into citeable blocks with one line per non-empty field', () => {
    const result = parseHl7(MESSAGE)
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0]?.blocks.map((block) => block.id)).toEqual(['SEG1', 'SEG2', 'SEG3', 'SEG4'])
    const text = result.pages[0]?.text ?? ''
    expect(text).toContain('PID-5: Doe^Jane')
    expect(text).toContain('OBX-5: 182')
    expect(text).toContain('OBX-6: mg/dL')
    expect(text).not.toContain('PID-2')
  })

  it('keeps unknown Z-segments verbatim so non-standard feeds need no code changes', () => {
    const text = parseHl7(MESSAGE).pages[0]?.text ?? ''
    expect(text).toContain('ZXX-1: 1')
    expect(text).toContain('ZXX-2: custom vendor field')
  })

  it('reads the version from MSH-12 and warns when it is not 2.x', () => {
    expect(parseHl7(MESSAGE).version).toBe('2.5.1')
    expect(parseHl7(MESSAGE).warnings).not.toContain('unknown_version')
    const unknown = parseHl7('MSH|^~\\&|A|B|C|D|202610071200||ADT^A01|1|P|3.0')
    expect(unknown.warnings).toContain('unknown_version')
  })

  it('honours custom delimiters declared in MSH', () => {
    const result = parseHl7(['MSH#^~\\&#A#B#C#D#202610071200##ADT^A01#1#P#2.3', 'PID#1##X1##Roe^Rick'].join('\r'))
    expect(result.pages[0]?.text).toContain('PID-5: Roe^Rick')
  })

  it('flags malformed segments instead of failing', () => {
    const result = parseHl7(['MSH|^~\\&|A|B|C|D|202610071200||ADT^A01|1|P|2.5', 'XX'].join('\r'))
    expect(result.warnings.some((warning) => warning.startsWith('truncated_segment'))).toBe(true)
  })

  it.each(['', 'not hl7 at all', 'PID|1||X'])('rejects %j as HL7_INVALID', (input) => {
    try {
      parseHl7(input)
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).reason).toBe('HL7_INVALID')
    }
  })
})

describe('unescapeHl7', () => {
  it('resolves the standard escape sequences', () => {
    expect(unescapeHl7('a\\F\\b', '|', '^~\\&')).toBe('a|b')
    expect(unescapeHl7('a\\S\\b\\T\\c\\R\\d\\E\\e', '|', '^~\\&')).toBe('a^b&c~d\\e')
    expect(unescapeHl7('line1\\.br\\line2', '|', '^~\\&')).toBe('line1\nline2')
    expect(unescapeHl7('\\X4142\\', '|', '^~\\&')).toBe('AB')
  })

  it('drops formatting codes and leaves an unterminated escape alone', () => {
    expect(unescapeHl7('\\H\\bold\\N\\ text', '|', '^~\\&')).toBe('bold text')
    expect(unescapeHl7('broken\\Fno-end', '|', '^~\\&')).toBe('broken\\Fno-end')
  })
})

describe('splitHl7Messages', () => {
  it('returns a single message unchanged', () => {
    expect(splitHl7Messages(MESSAGE)).toEqual([MESSAGE])
  })

  it('splits a batch and drops FHS/BHS/BTS/FTS envelope segments', () => {
    const batch = [...ENVELOPE, MESSAGE, MESSAGE.replace('MSG001', 'MSG002'), 'BTS|2', 'FTS|1'].join('\r')
    const messages = splitHl7Messages(batch)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain('MSG001')
    expect(messages[1]).toContain('MSG002')
    expect(messages.join('')).not.toContain('BHS')
  })
})
