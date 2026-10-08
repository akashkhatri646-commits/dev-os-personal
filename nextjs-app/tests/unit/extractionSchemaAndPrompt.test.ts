import { describe, expect, it } from 'vitest'
import { DISCHARGE_SUMMARY_CATALOG, parseFieldKey, resolveField, formatFieldKey } from '@/server/services/extraction/fieldCatalog'
import { groundExtraction } from '@/server/services/extraction/grounding'
import {
  BUILTIN_EXTRACTION_PROMPT,
  FEW_SHOT_EXAMPLES,
  buildExtractionMessages,
  buildSystemPrompt,
  renderCatalogue,
  renderDocument,
} from '@/server/services/extraction/prompt'
import { EXTRACTION_JSON_SCHEMA, EXTRACTION_SCHEMA, extractionResultSchema } from '@/server/services/extraction/schema'
import { LlmSchemaError } from '@/types/llm'
import type { OcrPage } from '@/types/ocr'

const found = {
  field_key: 'medication[0].name',
  value: 'Metformin',
  found: true,
  basis: 'stated',
  confidence: 0.9,
  source: { page: 1, block_ids: ['p1b1'], quote: 'Tab Metformin' },
}
const notFound = { field_key: 'medication[0].route', value: null, found: false, basis: null, confidence: 0, source: null }

describe('extraction output schema (Zod)', () => {
  it('accepts a found field with its source and a not-found field with none', () => {
    expect(extractionResultSchema.safeParse({ fields: [found, notFound], document_notes: '' }).success).toBe(true)
  })

  it.each([
    ['found without a source', { ...found, source: null }],
    ['found without a value', { ...found, value: null }],
    ['found with a blank value', { ...found, value: '  ' }],
    ['found without a basis', { ...found, basis: null }],
    ['not found but carrying a value', { ...notFound, value: 'x' }],
    ['not found but carrying a source', { ...notFound, source: found.source }],
    ['confidence above 1', { ...found, confidence: 1.2 }],
    ['an empty quote', { ...found, source: { ...found.source, quote: '' } }],
    ['no cited blocks', { ...found, source: { ...found.source, block_ids: [] } }],
    ['a quote over 500 characters', { ...found, source: { ...found.source, quote: 'x'.repeat(501) } }],
    ['a malformed field key', { ...found, field_key: 'Medication 0 name' }],
    ['a numeric value (values are always text)', { ...found, value: 500 }],
  ])('rejects %s', (_label, field) => {
    expect(extractionResultSchema.safeParse({ fields: [field], document_notes: '' }).success).toBe(false)
  })

  it('turns an invalid reply into an LlmSchemaError whose detail names the problems but no document text', () => {
    let thrown: unknown
    try {
      EXTRACTION_SCHEMA.parse({ fields: [{ ...found, source: null, value: 'SECRET-PATIENT-TEXT' }], document_notes: '' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LlmSchemaError)
    const detail = (thrown as LlmSchemaError).detail
    expect(detail).toContain('source')
    expect(detail).not.toContain('SECRET-PATIENT-TEXT')
  })

  it('returns the validated output for a good reply', () => {
    const output = EXTRACTION_SCHEMA.parse({ fields: [found], document_notes: 'ok' })
    expect(output.fields).toHaveLength(1)
  })
})

type Json = Record<string, unknown>

/** OpenAI strict structured outputs: every object lists all its properties as required and forbids extras. */
function assertStrictCompatible(schema: unknown, path = '$'): void {
  if (typeof schema !== 'object' || schema === null) return
  const node = schema as Json
  const allowedKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf'])
  for (const key of Object.keys(node)) expect(allowedKeys.has(key), `${path}: keyword "${key}" is not allowed in strict mode`).toBe(true)

  if (node.type === 'object') {
    const properties = Object.keys((node.properties ?? {}) as Json)
    expect(node.additionalProperties, `${path}: additionalProperties must be false`).toBe(false)
    expect([...(node.required as string[])].sort(), `${path}: every property must be required`).toEqual([...properties].sort())
    for (const [name, child] of Object.entries((node.properties ?? {}) as Json)) assertStrictCompatible(child, `${path}.${name}`)
  }
  if (node.items) assertStrictCompatible(node.items, `${path}[]`)
  if (Array.isArray(node.anyOf)) node.anyOf.forEach((branch, index) => assertStrictCompatible(branch, `${path}|${index}`))
}

describe('tidying slips in the model answer', () => {
  const found = { field_key: 'diagnosis[0].text', value: 'Hypertension', found: true, basis: 'stated', confidence: 0.9, source: { page: 1, block_ids: ['p1b1'], quote: 'Hypertension' } }
  const missing = { field_key: 'medication[0].route', value: null, found: false, basis: null, confidence: 0, source: null }

  it('accepts a not-found field that carries an empty string or a leftover source instead of nulls', () => {
    const slipped = [
      { ...missing, value: '' },
      { ...missing, value: 'oral', source: { page: 1, block_ids: [], quote: '' } },
      { ...missing, basis: 'stated', confidence: 0.4 },
    ]
    const result = EXTRACTION_SCHEMA.parse({ fields: [found, ...slipped], document_notes: '' })
    expect(result.fields).toHaveLength(4)
    for (const field of result.fields.slice(1)) expect(field).toMatchObject({ found: false, value: null, source: null })
  })

  it('clamps a confidence outside 0 to 1 and cuts over-long notes', () => {
    const result = EXTRACTION_SCHEMA.parse({ fields: [{ ...found, confidence: 1.4 }, { ...missing, confidence: -0.2 }], document_notes: 'x'.repeat(900) })
    expect(result.fields.map((field) => field.confidence)).toEqual([1, 0])
    expect(result.document_notes).toHaveLength(500)
  })

  it('still rejects a found field that lacks a value, a source or a basis, and names the problem', () => {
    for (const broken of [{ ...found, value: '' }, { ...found, source: null }, { ...found, basis: null }]) {
      expect(() => EXTRACTION_SCHEMA.parse({ fields: [broken], document_notes: '' })).toThrow(LlmSchemaError)
    }
  })

  it('never changes what a found value says', () => {
    const result = EXTRACTION_SCHEMA.parse({ fields: [found], document_notes: 'ok' })
    expect(result.fields[0]).toMatchObject({ value: 'Hypertension', source: { quote: 'Hypertension' } })
  })
})

describe('extraction JSON schema sent to the provider', () => {
  it('satisfies the strict structured-outputs rules at every level', () => {
    assertStrictCompatible(EXTRACTION_JSON_SCHEMA)
  })

  it('describes the same fields the Zod validator expects', () => {
    const fieldProperties = Object.keys((((EXTRACTION_JSON_SCHEMA.properties as Json).fields as Json).items as Json).properties as Json).sort()
    expect(fieldProperties).toEqual(Object.keys(found).sort())
    expect(Object.keys(EXTRACTION_JSON_SCHEMA.properties as Json).sort()).toEqual(['document_notes', 'fields'])
  })
})

describe('field catalogue', () => {
  it('parses and formats field keys symmetrically', () => {
    expect(parseFieldKey('medication[3].dose_value')).toEqual({ entity: 'medication', index: 3, attribute: 'dose_value' })
    expect(parseFieldKey('encounter.admission_date')).toEqual({ entity: 'encounter', index: null, attribute: 'admission_date' })
    expect(parseFieldKey('nonsense')).toBeNull()
    expect(formatFieldKey('medication', 3, 'dose_value')).toBe('medication[3].dose_value')
    expect(formatFieldKey('encounter', null, 'admission_date')).toBe('encounter.admission_date')
  })

  it('resolves only keys the catalogue defines, with the right index rules', () => {
    expect(resolveField(DISCHARGE_SUMMARY_CATALOG, 'medication[0].name')?.entity.resourceType).toBe('MedicationRequest')
    expect(resolveField(DISCHARGE_SUMMARY_CATALOG, 'medication.name')).toBeNull()
    expect(resolveField(DISCHARGE_SUMMARY_CATALOG, 'encounter[0].admission_date')).toBeNull()
    expect(resolveField(DISCHARGE_SUMMARY_CATALOG, 'medication[0].colour')).toBeNull()
    expect(resolveField(DISCHARGE_SUMMARY_CATALOG, 'ghost[0].name')).toBeNull()
  })

  it('marks the required attributes the spec lists', () => {
    const required = (entity: string) =>
      DISCHARGE_SUMMARY_CATALOG.find((candidate) => candidate.entity === entity)?.attributes.filter((attribute) => attribute.required).map((attribute) => attribute.name)
    expect(required('medication')).toEqual(['name', 'dose_value', 'dose_unit', 'frequency'])
    expect(required('encounter')).toEqual(['admission_date', 'discharge_date'])
    expect(required('lab')).toEqual(['test_name', 'value'])
  })
})

describe('prompt', () => {
  const catalogue = renderCatalogue(DISCHARGE_SUMMARY_CATALOG)
  const system = buildSystemPrompt(DISCHARGE_SUMMARY_CATALOG)

  it('lists every catalogue entity and marks required attributes', () => {
    for (const entity of DISCHARGE_SUMMARY_CATALOG) expect(catalogue).toContain(entity.entity)
    expect(catalogue).toContain('dose_value*')
    expect(catalogue).toContain('twice daily')
  })

  it('states the non-negotiable rules: quote, not found over guessing, untrusted document', () => {
    expect(system).toMatch(/not stated in the document, return found:false/)
    expect(system).toMatch(/Never guess/)
    expect(system).toMatch(/untrusted data/)
    expect(system).toMatch(/exactly as it appears/)
  })

  it('renders the document with a citable id on every block and indents continuation lines', () => {
    const pages: OcrPage[] = [
      { page: 1, text: '', confidence: 1, blocks: [{ id: 'p1b1', text: 'Line one' }, { id: 'p1b2', text: 'PID\nPID-5: Doe' }] },
      { page: 2, text: '', confidence: 1, blocks: [{ id: 'p2b1', text: 'Next page' }] },
    ]
    const rendered = renderDocument(pages)
    expect(rendered).toContain('[PAGE 1]')
    expect(rendered).toContain('[p1b1] Line one')
    expect(rendered).toContain('[p1b2] PID\n    PID-5: Doe')
    expect(rendered).toContain('[PAGE 2]')
    expect(rendered.startsWith('<document>')).toBe(true)
    expect(rendered.endsWith('</document>')).toBe(true)
  })

  it('puts the worked examples first and the real document last, as alternating turns', () => {
    const doc: OcrPage[] = [{ page: 1, text: 'x', confidence: 1, blocks: [{ id: 'p1b1', text: 'REAL DOCUMENT' }] }]
    const messages = buildExtractionMessages(doc, BUILTIN_EXTRACTION_PROMPT.few_shot)
    expect(messages).toHaveLength(BUILTIN_EXTRACTION_PROMPT.few_shot.length * 2 + 1)
    expect(messages.map((message) => message.role).slice(0, 4)).toEqual(['user', 'assistant', 'user', 'assistant'])
    const last = messages[messages.length - 1]
    expect(last?.role).toBe('user')
    expect(String(last?.content)).toContain('REAL DOCUMENT')
  })

  it('is a stable, versioned built-in', () => {
    expect(BUILTIN_EXTRACTION_PROMPT.version).toBe('extraction-v1')
    expect(BUILTIN_EXTRACTION_PROMPT.template).toBe(system)
  })
})

describe('few-shot examples teach correct behaviour', () => {
  it.each(FEW_SHOT_EXAMPLES.map((example, index) => [index + 1, example] as const))('example %s is valid output', (_n, example) => {
    expect(extractionResultSchema.safeParse(example.output).success).toBe(true)
  })

  it.each(FEW_SHOT_EXAMPLES.map((example, index) => [index + 1, example] as const))(
    'example %s passes its own grounding check with nothing dropped',
    (_n, example) => {
      const report = groundExtraction(example.output, example.pages, DISCHARGE_SUMMARY_CATALOG)
      expect(report.dropped).toEqual([])
      expect(report.injectionSuspected).toBe(false)
    },
  )

  it('shows a missing unit being returned as not found rather than guessed', () => {
    const unitless = FEW_SHOT_EXAMPLES[1]?.output.fields.filter((field) => field.field_key.endsWith('dose_unit')) ?? []
    expect(unitless).toHaveLength(2)
    expect(unitless.every((field) => !field.found && field.value === null)).toBe(true)
  })

  it('shows an embedded instruction being ignored', () => {
    const example = FEW_SHOT_EXAMPLES[2]
    expect(example?.pages[0]?.text).toMatch(/Ignore previous instructions/)
    expect(JSON.stringify(example?.output.fields)).not.toContain('1000')
  })
})
