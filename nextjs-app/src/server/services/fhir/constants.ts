/** FHIR code systems and value sets used by the builders and the validator. */
export const SYSTEM = {
  ucum: 'http://unitsofmeasure.org',
  actCode: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
  conditionClinical: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
  conditionVerification: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
  allergyClinical: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
  allergyVerification: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification',
  observationCategory: 'http://terminology.hl7.org/CodeSystem/observation-category',
  interpretation: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
  timingEvent: 'http://hl7.org/fhir/event-timing',
  provenanceTag: 'urn:health-ingest:provenance',
  snomed: 'http://snomed.info/sct',
  loinc: 'http://loinc.org',
  icd10: 'http://hl7.org/fhir/sid/icd-10',
} as const

/** Systems a coded element may use. Anything else is rejected by the validator. */
export const ALLOWED_CODE_SYSTEMS: readonly string[] = [
  SYSTEM.snomed,
  SYSTEM.loinc,
  SYSTEM.icd10,
  SYSTEM.ucum,
  SYSTEM.actCode,
  SYSTEM.conditionClinical,
  SYSTEM.conditionVerification,
  SYSTEM.allergyClinical,
  SYSTEM.allergyVerification,
  SYSTEM.observationCategory,
  SYSTEM.interpretation,
  SYSTEM.timingEvent,
  SYSTEM.provenanceTag,
]

/** Resources are validated against the base R4 definitions; national profiles apply in service mode. */
export const profileUrl = (resourceType: string) => `http://hl7.org/fhir/StructureDefinition/${resourceType}`

export const AI_EXTRACTED_TAG = { system: SYSTEM.provenanceTag, code: 'ai-extracted', display: 'AI-extracted' } as const

/** Dose units as UCUM: the display text and the UCUM code (annotations in braces for dose forms). */
export const UCUM_UNITS: Record<string, { unit: string; code: string }> = {
  mg: { unit: 'mg', code: 'mg' },
  mcg: { unit: 'mcg', code: 'ug' },
  g: { unit: 'g', code: 'g' },
  ml: { unit: 'mL', code: 'mL' },
  iu: { unit: 'IU', code: '[IU]' },
  unit: { unit: 'unit', code: 'U' },
  tablet: { unit: 'tablet', code: '{tablet}' },
  capsule: { unit: 'capsule', code: '{capsule}' },
  drop: { unit: 'drop', code: '[drp]' },
  puff: { unit: 'puff', code: '{puff}' },
}

/** Laboratory units accepted verbatim as UCUM. A unit outside this list is flagged `unit_unmapped`. */
export const LAB_UCUM_UNITS: readonly string[] = [
  'mg/dL', 'g/dL', 'g/L', 'mg/L', 'ug/dL', 'ng/mL', 'pg/mL', 'ng/dL', 'mmol/L', 'umol/L', 'mEq/L', 'U/L', 'IU/L',
  '%', 'fL', 'pg', '/uL', '10*3/uL', '10*6/uL', '10*9/L', '10*12/L', 'mm[Hg]', 'mL/min', 'mm/h', 's', 'kg', 'g',
]

export interface TimingSpec {
  frequency?: number
  period?: number
  periodUnit?: 'h' | 'd' | 'wk'
  when?: string[]
  asNeeded?: boolean
}

/** Canonical frequency to structured FHIR timing. */
export const TIMING: Record<string, TimingSpec> = {
  'once daily': { frequency: 1, period: 1, periodUnit: 'd' },
  'twice daily': { frequency: 2, period: 1, periodUnit: 'd' },
  'three times daily': { frequency: 3, period: 1, periodUnit: 'd' },
  'four times daily': { frequency: 4, period: 1, periodUnit: 'd' },
  'at bedtime': { frequency: 1, period: 1, periodUnit: 'd', when: ['HS'] },
  'every 8 hours': { frequency: 1, period: 8, periodUnit: 'h' },
  'every 12 hours': { frequency: 1, period: 12, periodUnit: 'h' },
  'as needed': { asNeeded: true },
  weekly: { frequency: 1, period: 1, periodUnit: 'wk' },
}

export const INTERPRETATION_CODES: Record<string, { code: string; display: string }> = {
  low: { code: 'L', display: 'Low' },
  normal: { code: 'N', display: 'Normal' },
  high: { code: 'H', display: 'High' },
  abnormal: { code: 'A', display: 'Abnormal' },
}

/** Fixed SNOMED CT concept used when a document explicitly states that no allergies are known. */
export const NO_KNOWN_ALLERGY = { system: SYSTEM.snomed, code: '716186003', display: 'No known allergy' } as const

/** LOINC document type for a discharge summary. */
export const DISCHARGE_SUMMARY_LOINC = { system: SYSTEM.loinc, code: '18842-5', display: 'Discharge summary' } as const
