const ENTITY_LABELS: Record<string, string> = {
  encounter: 'Encounter',
  diagnosis: 'Diagnosis',
  medication: 'Medication',
  allergy: 'Allergy',
  allergy_status: 'Allergy status',
  lab: 'Lab result',
  procedure: 'Procedure',
  report: 'Report',
}

const humanize = (word: string) => {
  const spaced = word.replaceAll('_', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

const FIELD_KEY = /^([a-z_]+)(?:\[(\d+)\])?\.([a-z_]+)$/

/** `medication[0].dose_value` -> "Medication 1 · Dose value". */
export function fieldLabel(fieldKey: string): string {
  const match = FIELD_KEY.exec(fieldKey)
  if (!match?.[1] || !match[3]) return fieldKey
  const entity = ENTITY_LABELS[match[1]] ?? humanize(match[1])
  const position = match[2] === undefined ? '' : ` ${Number(match[2]) + 1}`
  return `${entity}${position} · ${humanize(match[3])}`
}

const CONCERNS: Record<string, string> = {
  missing_required: 'Required, not found',
  ungrounded: 'Not found in the document',
  inferred: 'Inferred, not stated',
  low_ocr_span: 'Poor scan quality',
  weak_match: 'Weak code match',
  uncoded: 'No code found',
  invalid_code_selection: 'Code choice rejected',
  range_value: 'Value is a range',
  unit_unmapped: 'Unit not recognised',
  incomplete_timing: 'Timing unclear',
  phase_unstated: 'Not stated if given at discharge',
  conflict: 'Conflicting values',
}

export function concernLabel(concern: string): string {
  return CONCERNS[concern] ?? humanize(concern)
}

export const RESOURCE_LABELS: Record<string, string> = {
  Encounter: 'Encounter',
  Condition: 'Diagnoses',
  MedicationRequest: 'Medications',
  AllergyIntolerance: 'Allergies',
  Observation: 'Lab results',
  Procedure: 'Procedures',
  DiagnosticReport: 'Report',
}
