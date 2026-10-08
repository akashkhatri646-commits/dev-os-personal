import { describe, expect, it } from 'vitest'
import { buildResources, type BuildContext } from '@/server/services/fhir/builders'
import { NodeFhirValidator, type ValidationContext } from '@/server/services/fhir/validator'
import { groupFields, type StoredField } from '@/server/services/mapping/entities'
import type { Coding } from '@/types/domain'

const span = { page: 1, block_ids: ['b1'], quote: 'q', char_start: 0, char_end: 1 }
const field = (field_key: string, value: string | number): StoredField => ({
  field_key,
  found: true,
  value,
  source_span: span,
  basis: 'stated',
  model_confidence: 0.9,
})

const coding = (field_key: string, system: Coding['system'], code: string, display: string): Coding => ({
  field_key,
  system,
  code,
  display,
  match_confidence: 0.9,
  candidates: [],
})

let counter = 0
const ctx = (codings: Coding[] = [], extra: Partial<BuildContext> = {}): BuildContext => ({
  patientId: 'p1',
  encounterId: null,
  newId: () => `id-${++counter}`,
  codings: new Map(codings.map((entry) => [entry.field_key, entry])),
  ...extra,
})

const validationContext = (resourceIds: string[], extra: Partial<ValidationContext> = {}): ValidationContext => ({
  patientId: 'p1',
  resourceIds: new Set(resourceIds),
  now: new Date('2026-01-01T00:00:00Z'),
  ...extra,
})

const discharge = [
  field('encounter.class', 'inpatient'),
  field('encounter.admission_date', '2025-03-01'),
  field('encounter.discharge_date', '2025-03-05'),
  field('diagnosis[0].text', 'Type 2 diabetes'),
  field('medication[0].name', 'Metformin'),
  field('medication[0].dose_value', 500),
  field('medication[0].dose_unit', 'mg'),
  field('medication[0].frequency', 'twice daily'),
  field('medication[0].phase', 'discharge'),
  field('medication[1].name', 'Heparin'),
  field('medication[1].phase', 'in_hospital'),
]

describe('buildResources', () => {
  it('builds the encounter first and links every other resource to it and to the patient', () => {
    const built = buildResources(groupFields(discharge), ctx())
    expect(built.map((entry) => entry.resourceType)).toEqual(['Encounter', 'Condition', 'MedicationRequest'])
    const encounterId = built[0]?.id
    for (const entry of built.slice(1)) {
      expect((entry.resource.encounter as { reference: string }).reference).toBe(`Encounter/${encounterId}`)
    }
    expect(built[1]?.resource.subject).toEqual({ reference: 'Patient/p1' })
  })

  it('keeps the pre-assigned id as the resource id and tags the resource as AI-extracted', () => {
    const [encounter] = buildResources(groupFields(discharge), ctx())
    expect(encounter?.resource.id).toBe(encounter?.id)
    expect(JSON.stringify(encounter?.resource.meta)).toContain('ai-extracted')
  })

  it('does not build in-hospital medications as active orders', () => {
    const built = buildResources(groupFields(discharge), ctx())
    expect(built.filter((entry) => entry.resourceType === 'MedicationRequest')).toHaveLength(1)
  })

  it('structures the dose as UCUM and the frequency as timing', () => {
    const med = buildResources(groupFields(discharge), ctx()).find((entry) => entry.resourceType === 'MedicationRequest')
    const dosage = (med?.resource.dosageInstruction as Record<string, any>[])[0]
    expect(dosage?.doseAndRate[0].doseQuantity).toEqual({ value: 500, unit: 'mg', system: 'http://unitsofmeasure.org', code: 'mg' })
    expect(dosage?.timing.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: 'd' })
  })

  it('flags uncoded concepts and puts a chosen code into the resource', () => {
    const uncoded = buildResources(groupFields(discharge), ctx()).find((entry) => entry.resourceType === 'Condition')
    expect(uncoded?.flags).toContain('uncoded')
    expect(uncoded?.resource.code).toEqual({ text: 'Type 2 diabetes' })

    const coded = buildResources(groupFields(discharge), ctx([coding('diagnosis[0].text', 'snomed', '44054006', 'Diabetes mellitus type 2')])).find(
      (entry) => entry.resourceType === 'Condition',
    )
    expect(coded?.flags).not.toContain('uncoded')
    expect(JSON.stringify(coded?.resource.code)).toContain('44054006')
    expect(coded?.codings).toHaveLength(1)
  })

  it('adds the secondary ICD-10 code only beside a primary code', () => {
    const both = buildResources(
      groupFields(discharge),
      ctx([coding('diagnosis[0].text', 'snomed', '44054006', 'T2DM'), coding('diagnosis[0].text#2', 'icd10', 'E11', 'T2DM')]),
    ).find((entry) => entry.resourceType === 'Condition')
    expect((both?.resource.code as { coding: unknown[] }).coding).toHaveLength(2)

    const secondaryOnly = buildResources(groupFields(discharge), ctx([coding('diagnosis[0].text#2', 'icd10', 'E11', 'T2DM')])).find(
      (entry) => entry.resourceType === 'Condition',
    )
    expect(secondaryOnly?.flags).toContain('uncoded')
  })

  it('flags a dose range, an unstated phase and an unmapped lab unit instead of guessing', () => {
    const built = buildResources(
      groupFields([
        field('medication[0].name', 'Morphine'),
        field('medication[0].dose_value', '5-10'),
        field('medication[0].dose_unit', 'mg'),
        field('lab[0].test_name', 'Glucose'),
        field('lab[0].value', 5.5),
        field('lab[0].unit', 'furlongs'),
      ]),
      ctx(),
    )
    const med = built.find((entry) => entry.resourceType === 'MedicationRequest')
    expect(med?.flags).toEqual(expect.arrayContaining(['range_value', 'phase_unstated']))
    const lab = built.find((entry) => entry.resourceType === 'Observation')
    expect(lab?.flags).toContain('unit_unmapped')
  })

  it('never invents the encounter class', () => {
    const [encounter] = buildResources(groupFields([field('encounter.admission_date', '2025-03-01')]), ctx())
    expect(encounter?.resource.class).toBeUndefined()
  })

  it('records a rejected code choice on the resource', () => {
    const med = buildResources(groupFields(discharge), ctx([], { invalidSelections: new Set(['medication[0].name']) })).find(
      (entry) => entry.resourceType === 'MedicationRequest',
    )
    expect(med?.flags).toEqual(expect.arrayContaining(['uncoded', 'invalid_code_selection']))
  })

  it('builds no-known-allergy only when the document states it', () => {
    expect(buildResources(groupFields([field('allergy_status.value', 'no_known_allergies')]), ctx()).map((entry) => entry.resourceType)).toEqual([
      'AllergyIntolerance',
    ])
    expect(buildResources(groupFields([field('diagnosis[0].text', 'x')]), ctx()).some((entry) => entry.resourceType === 'AllergyIntolerance')).toBe(false)
  })
})

describe('NodeFhirValidator', () => {
  const validator = new NodeFhirValidator()
  const built = () => buildResources(groupFields(discharge), ctx())

  it('passes a complete record', async () => {
    const resources = built().map((entry) => entry.resource)
    const results = await validator.validate(resources, validationContext(resources.map((resource) => resource.id)))
    expect(results.map((result) => result.status)).toEqual(['pass', 'pass', 'pass'])
  })

  it('fails an encounter with no class, reporting the missing element', async () => {
    const [encounter] = buildResources(groupFields([field('encounter.admission_date', '2025-03-01')]), ctx())
    const [result] = await validator.validate([encounter!.resource], validationContext([encounter!.id]))
    expect(result?.status).toBe('fail')
    expect(result?.issues.some((issue) => issue.path === 'class' && issue.code === 'required')).toBe(true)
  })

  it('rejects future dates, dates before 1900, and a discharge before admission', async () => {
    const make = (admission: string, discharge: string) =>
      buildResources(groupFields([field('encounter.class', 'inpatient'), field('encounter.admission_date', admission), field('encounter.discharge_date', discharge)]), ctx())[0]!
    const check = async (entry: ReturnType<typeof make>) => (await validator.validate([entry.resource], validationContext([entry.id])))[0]
    expect((await check(make('2025-03-01', '2027-01-01')))?.issues.map((issue) => issue.ruleId)).toContain('date.future')
    expect((await check(make('1850-01-01', '1850-01-02')))?.issues.map((issue) => issue.ruleId)).toContain('date.floor')
    expect((await check(make('2025-03-05', '2025-03-01')))?.issues.map((issue) => issue.ruleId)).toContain('date.order')
  })

  it('rejects a reference to a resource outside the record and a different patient', async () => {
    const resources = built().map((entry) => entry.resource)
    const results = await validator.validate(resources, validationContext([], { patientId: 'someone-else' }))
    const ruleIds = results.flatMap((result) => result.issues.map((issue) => issue.ruleId))
    expect(ruleIds).toContain('reference.patient')
    expect(ruleIds).toContain('reference.target')
  })

  it('rejects a zero dose and a disallowed code system', async () => {
    const med = buildResources(
      groupFields([field('medication[0].name', 'X'), field('medication[0].dose_value', 0), field('medication[0].dose_unit', 'mg'), field('medication[0].phase', 'discharge')]),
      ctx(),
    )[0]!
    const resource = { ...med.resource, medicationCodeableConcept: { coding: [{ system: 'http://example.org/made-up', code: '1' }] } }
    const [result] = await validator.validate([resource], validationContext([med.id]))
    const ruleIds = result?.issues.map((issue) => issue.ruleId)
    expect(ruleIds).toContain('dose.positive')
    expect(ruleIds).toContain('coding.system')
  })

  it('rejects a code that is not in the terminology, but not the fixed codes', async () => {
    const coded = buildResources(groupFields(discharge), ctx([coding('diagnosis[0].text', 'snomed', '999', 'Made up')])).find((entry) => entry.resourceType === 'Condition')!
    const [result] = await validator.validate([coded.resource], validationContext([], { isKnownCode: async () => false }))
    expect(result?.issues.some((issue) => issue.ruleId === 'coding.exists')).toBe(true)

    const [nkda] = buildResources(groupFields([field('allergy_status.value', 'no_known_allergies')]), ctx())
    const [fixed] = await validator.validate([nkda!.resource], validationContext([], { isKnownCode: async () => false }))
    expect(fixed?.status).toBe('pass')
  })

  it('never changes the resources it checks', async () => {
    const resources = built().map((entry) => entry.resource)
    const before = JSON.stringify(resources)
    await validator.validate(resources, validationContext([]))
    expect(JSON.stringify(resources)).toBe(before)
  })
})
