import {
  AI_EXTRACTED_TAG,
  DISCHARGE_SUMMARY_LOINC,
  INTERPRETATION_CODES,
  LAB_UCUM_UNITS,
  NO_KNOWN_ALLERGY,
  SYSTEM,
  TIMING,
  UCUM_UNITS,
  profileUrl,
} from '@/server/services/fhir/constants'
import type { EntityInstance, FieldValue } from '@/server/services/mapping/entities'
import { FHIR_SYSTEM_URI, type Coding, type ResourceType } from '@/types/domain'

export interface FhirResource {
  resourceType: string
  id: string
  [key: string]: unknown
}

/** A resource ready to store, with the codes that were chosen for it and any reasons it must not auto-commit. */
export interface BuiltResource {
  id: string
  resourceType: ResourceType
  resource: FhirResource
  codings: Coding[]
  /** The entity this was built from (`medication[0]`), so scoring can find its fields. */
  sourceRef: string
  /** Machine-readable risk flags read by scoring: uncoded, range_value, phase_unstated, unit_unmapped, ... */
  flags: string[]
  profileUrl: string
}

export interface BuildContext {
  patientId: string
  /** Id of the encounter built from this record, when there is one. */
  encounterId: string | null
  /** Assigns the id a resource keeps all the way into the committed store (the same entity keeps its id when rebuilt). */
  newId: (sourceRef: string) => string
  /** Codes chosen for each codeable field, keyed by its field key (`diagnosis[0].text`). */
  codings: ReadonlyMap<string, Coding>
  /** Fields where the model's code choice was rejected as not one of the offered candidates. */
  invalidSelections?: ReadonlySet<string>
}

const text = (field: FieldValue | undefined): string | undefined =>
  field === undefined ? undefined : String(field.value).trim() || undefined

const defined = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T

function baseResource(type: ResourceType, id: string): FhirResource {
  return {
    resourceType: type,
    id,
    meta: { profile: [profileUrl(type)], tag: [AI_EXTRACTED_TAG] },
  }
}

const patientRef = (ctx: BuildContext) => ({ reference: `Patient/${ctx.patientId}` })
const encounterRef = (ctx: BuildContext) => (ctx.encounterId ? { reference: `Encounter/${ctx.encounterId}` } : undefined)

function codeableConcept(
  ctx: BuildContext,
  fieldKey: string,
  display: string | undefined,
  flags: string[],
  codings: Coding[],
) {
  const chosen = ctx.codings.get(fieldKey)
  if (!chosen) {
    flags.push('uncoded')
    if (ctx.invalidSelections?.has(fieldKey)) flags.push('invalid_code_selection')
    return { text: display }
  }
  codings.push(chosen)
  return {
    coding: [{ system: FHIR_SYSTEM_URI[chosen.system], code: chosen.code, display: chosen.display }],
    text: display,
  }
}

/**
 * The same concept may carry a second, secondary-system code (an ICD-10 code beside the SNOMED one).
 * Those are stored under `<field_key>#2` by the mapping step.
 */
function withSecondaryCoding(
  concept: ReturnType<typeof codeableConcept>,
  ctx: BuildContext,
  fieldKey: string,
  codings: Coding[],
) {
  const secondary = ctx.codings.get(`${fieldKey}#2`)
  if (!secondary || !('coding' in concept)) return concept
  codings.push(secondary)
  return {
    ...concept,
    coding: [...(concept.coding ?? []), { system: FHIR_SYSTEM_URI[secondary.system], code: secondary.code, display: secondary.display }],
  }
}

export function buildEncounter(instance: EntityInstance, ctx: BuildContext): BuiltResource {
  const id = ctx.newId(instance.ref)
  const { attrs } = instance
  const encounterClass = text(attrs.class)
  const resource: FhirResource = {
    ...baseResource('Encounter', id),
    status: 'finished',
    // The class is never assumed: a discharge summary that does not say fails validation and is reviewed.
    class:
      encounterClass === 'inpatient'
        ? { system: SYSTEM.actCode, code: 'IMP', display: 'inpatient encounter' }
        : encounterClass === 'outpatient'
          ? { system: SYSTEM.actCode, code: 'AMB', display: 'ambulatory' }
          : undefined,
    subject: patientRef(ctx),
    period: defined({ start: text(attrs.admission_date), end: text(attrs.discharge_date) }),
    serviceProvider: text(attrs.facility_name) ? { display: text(attrs.facility_name) } : undefined,
    participant: text(attrs.attending_practitioner) ? [{ individual: { display: text(attrs.attending_practitioner) } }] : undefined,
  }
  return { id, sourceRef: instance.ref, resourceType: 'Encounter', resource: defined(resource) as FhirResource, codings: [], flags: [], profileUrl: profileUrl('Encounter') }
}

export function buildCondition(instance: EntityInstance, ctx: BuildContext): BuiltResource {
  const id = ctx.newId(instance.ref)
  const flags: string[] = []
  const codings: Coding[] = []
  const key = `${instance.ref}.text`
  const display = text(instance.attrs.text)
  const code = withSecondaryCoding(codeableConcept(ctx, key, display, flags, codings), ctx, key, codings)
  const resource: FhirResource = {
    ...baseResource('Condition', id),
    clinicalStatus: {
      coding: [{ system: SYSTEM.conditionClinical, code: text(instance.attrs.status) === 'resolved' ? 'resolved' : 'active' }],
    },
    verificationStatus: { coding: [{ system: SYSTEM.conditionVerification, code: 'confirmed' }] },
    code,
    subject: patientRef(ctx),
    encounter: encounterRef(ctx),
    onsetDateTime: text(instance.attrs.onset_date),
  }
  return { id, sourceRef: instance.ref, resourceType: 'Condition', resource: defined(resource) as FhirResource, codings, flags, profileUrl: profileUrl('Condition') }
}

function doseQuantity(value: number, unit: { unit: string; code: string }) {
  return { value, unit: unit.unit, system: SYSTEM.ucum, code: unit.code }
}

export function buildMedicationRequest(instance: EntityInstance, ctx: BuildContext): BuiltResource {
  const id = ctx.newId(instance.ref)
  const flags: string[] = []
  const codings: Coding[] = []
  const { attrs } = instance
  const display = text(attrs.name)
  if (!attrs.phase) flags.push('phase_unstated')

  const unit = text(attrs.dose_unit) ? UCUM_UNITS[text(attrs.dose_unit) as string] : undefined
  if (text(attrs.dose_unit) && !unit) flags.push('unit_unmapped')

  let doseAndRate: unknown[] | undefined
  const dose = attrs.dose_value?.value
  if (typeof dose === 'number' && unit) {
    doseAndRate = [{ doseQuantity: doseQuantity(dose, unit) }]
  } else if (typeof dose === 'string' && unit) {
    // A dose range ("5-10") is kept as a range and always flagged: it never auto-commits.
    const [low, high] = dose.split('-').map(Number)
    if (low !== undefined && high !== undefined && Number.isFinite(low) && Number.isFinite(high)) {
      doseAndRate = [{ doseRange: { low: doseQuantity(low, unit), high: doseQuantity(high, unit) } }]
    }
    flags.push('range_value')
  }

  const frequency = text(attrs.frequency)
  const timing = frequency ? TIMING[frequency] : undefined
  if (frequency && !timing) flags.push('incomplete_timing')

  const dosage = defined({
    text: text(attrs.instruction_text) ?? attrs.name?.span.quote,
    timing: timing && !timing.asNeeded
      ? { repeat: defined({ frequency: timing.frequency, period: timing.period, periodUnit: timing.periodUnit, when: timing.when }) }
      : undefined,
    asNeededBoolean: timing?.asNeeded ? true : undefined,
    route: text(attrs.route) ? { text: text(attrs.route) } : undefined,
    doseAndRate,
  })

  const resource: FhirResource = {
    ...baseResource('MedicationRequest', id),
    status: 'active',
    intent: 'order',
    medicationCodeableConcept: codeableConcept(ctx, `${instance.ref}.name`, display, flags, codings),
    subject: patientRef(ctx),
    encounter: encounterRef(ctx),
    dosageInstruction: [dosage],
  }
  return { id, sourceRef: instance.ref, resourceType: 'MedicationRequest', resource: defined(resource) as FhirResource, codings, flags, profileUrl: profileUrl('MedicationRequest') }
}

export function buildAllergyIntolerance(instance: EntityInstance, ctx: BuildContext): BuiltResource {
  const id = ctx.newId(instance.ref)
  const flags: string[] = []
  const codings: Coding[] = []
  const { attrs } = instance
  const reaction = text(attrs.reaction)
  const severity = text(attrs.severity)
  const resource: FhirResource = {
    ...baseResource('AllergyIntolerance', id),
    clinicalStatus: { coding: [{ system: SYSTEM.allergyClinical, code: 'active' }] },
    verificationStatus: { coding: [{ system: SYSTEM.allergyVerification, code: 'confirmed' }] },
    code: codeableConcept(ctx, `${instance.ref}.substance`, text(attrs.substance), flags, codings),
    patient: patientRef(ctx),
    reaction: reaction || severity ? [defined({ manifestation: [{ text: reaction ?? 'unspecified' }], severity })] : undefined,
  }
  return { id, sourceRef: instance.ref, resourceType: 'AllergyIntolerance', resource: defined(resource) as FhirResource, codings, flags, profileUrl: profileUrl('AllergyIntolerance') }
}

/** "No known allergies", only when the document states it explicitly. */
export function buildNoKnownAllergy(ctx: BuildContext): BuiltResource {
  const id = ctx.newId('allergy_status')
  const resource: FhirResource = {
    ...baseResource('AllergyIntolerance', id),
    clinicalStatus: { coding: [{ system: SYSTEM.allergyClinical, code: 'active' }] },
    verificationStatus: { coding: [{ system: SYSTEM.allergyVerification, code: 'confirmed' }] },
    code: { coding: [{ ...NO_KNOWN_ALLERGY }], text: 'No known allergies' },
    patient: patientRef(ctx),
  }
  return { id, sourceRef: 'allergy_status', resourceType: 'AllergyIntolerance', resource, codings: [], flags: [], profileUrl: profileUrl('AllergyIntolerance') }
}

export function buildObservation(instance: EntityInstance, ctx: BuildContext): BuiltResource {
  const id = ctx.newId(instance.ref)
  const flags: string[] = []
  const codings: Coding[] = []
  const { attrs } = instance
  const value = attrs.value?.value
  const unit = text(attrs.unit)

  let valueQuantity: unknown
  let valueString: string | undefined
  if (typeof value === 'number') {
    if (unit && !LAB_UCUM_UNITS.includes(unit)) flags.push('unit_unmapped')
    valueQuantity = defined({ value, unit, system: unit ? SYSTEM.ucum : undefined, code: unit && LAB_UCUM_UNITS.includes(unit) ? unit : undefined })
  } else if (typeof value === 'string') {
    valueString = value
    // A range or any non-numeric result is kept as text and never auto-committed.
    if (/^\d+(?:\.\d+)?\s*-\s*\d/.test(value)) flags.push('range_value')
  }

  const interpretation = text(attrs.interpretation) ? INTERPRETATION_CODES[text(attrs.interpretation) as string] : undefined
  const resource: FhirResource = {
    ...baseResource('Observation', id),
    status: 'final',
    category: [{ coding: [{ system: SYSTEM.observationCategory, code: 'laboratory', display: 'Laboratory' }] }],
    code: codeableConcept(ctx, `${instance.ref}.test_name`, text(attrs.test_name), flags, codings),
    subject: patientRef(ctx),
    encounter: encounterRef(ctx),
    effectiveDateTime: text(attrs.collected_date),
    valueQuantity,
    valueString,
    interpretation: interpretation ? [{ coding: [{ system: SYSTEM.interpretation, ...interpretation }] }] : undefined,
    referenceRange: text(attrs.reference_range) ? [{ text: text(attrs.reference_range) }] : undefined,
  }
  return { id, sourceRef: instance.ref, resourceType: 'Observation', resource: defined(resource) as FhirResource, codings, flags, profileUrl: profileUrl('Observation') }
}

export function buildProcedure(instance: EntityInstance, ctx: BuildContext): BuiltResource {
  const id = ctx.newId(instance.ref)
  const flags: string[] = []
  const codings: Coding[] = []
  const resource: FhirResource = {
    ...baseResource('Procedure', id),
    status: 'completed',
    code: codeableConcept(ctx, `${instance.ref}.name`, text(instance.attrs.name), flags, codings),
    subject: patientRef(ctx),
    encounter: encounterRef(ctx),
    performedDateTime: text(instance.attrs.date),
  }
  return { id, sourceRef: instance.ref, resourceType: 'Procedure', resource: defined(resource) as FhirResource, codings, flags, profileUrl: profileUrl('Procedure') }
}

export function buildDiagnosticReport(instance: EntityInstance, ctx: BuildContext, observationIds: readonly string[]): BuiltResource {
  const id = ctx.newId(instance.ref)
  const resource: FhirResource = {
    ...baseResource('DiagnosticReport', id),
    status: 'final',
    code: { coding: [{ ...DISCHARGE_SUMMARY_LOINC }], text: text(instance.attrs.title) },
    subject: patientRef(ctx),
    encounter: encounterRef(ctx),
    result: observationIds.length > 0 ? observationIds.map((observationId) => ({ reference: `Observation/${observationId}` })) : undefined,
    conclusion: text(instance.attrs.summary_text),
  }
  return { id, sourceRef: instance.ref, resourceType: 'DiagnosticReport', resource: defined(resource) as FhirResource, codings: [], flags: [], profileUrl: profileUrl('DiagnosticReport') }
}

/**
 * Builds every resource a record supports, in dependency order (the encounter first, because the rest
 * point at it; observations before the report that lists them). Only grounded fields are used and no
 * required element is ever invented: a missing one is reported by the validator, not filled in.
 * Medications given only in hospital are not turned into active orders.
 */
export function buildResources(instances: readonly EntityInstance[], ctx: BuildContext): BuiltResource[] {
  const built: BuiltResource[] = []
  const all = (entity: string) => instances.filter((instance) => instance.entity === entity)

  const encounter = all('encounter')[0]
  let context = ctx
  if (encounter) {
    const result = buildEncounter(encounter, ctx)
    built.push(result)
    context = { ...ctx, encounterId: result.id }
  }

  for (const instance of all('diagnosis')) built.push(buildCondition(instance, context))
  for (const instance of all('medication')) {
    if (text(instance.attrs.phase) === 'in_hospital') continue
    built.push(buildMedicationRequest(instance, context))
  }
  for (const instance of all('allergy')) built.push(buildAllergyIntolerance(instance, context))
  if (all('allergy_status').some((instance) => text(instance.attrs.value) === 'no_known_allergies')) {
    built.push(buildNoKnownAllergy(context))
  }
  const observations = all('lab').map((instance) => buildObservation(instance, context))
  built.push(...observations)
  for (const instance of all('procedure')) built.push(buildProcedure(instance, context))
  const report = all('report')[0]
  if (report) built.push(buildDiagnosticReport(report, context, observations.map((observation) => observation.id)))
  return built
}
