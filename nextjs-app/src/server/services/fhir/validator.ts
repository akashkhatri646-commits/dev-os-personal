import { AppError } from '@/lib/api/errors'
import { getEnv } from '@/server/config/env'
import { ALLOWED_CODE_SYSTEMS, DISCHARGE_SUMMARY_LOINC, NO_KNOWN_ALLERGY, SYSTEM } from '@/server/services/fhir/constants'
import type { FhirResource } from '@/server/services/fhir/builders'

export type IssueSeverity = 'error' | 'warning'

export interface ValidationIssue {
  severity: IssueSeverity
  code: 'required' | 'invalid_value' | 'invalid_reference' | 'invalid_code' | 'implausible'
  path: string
  message: string
  ruleId: string
}

export interface ValidationResult {
  resourceId: string
  status: 'pass' | 'fail'
  issues: ValidationIssue[]
}

export interface ValidationContext {
  /** The record's patient, which every resource must point at. */
  patientId: string
  /** Every resource id in the record, so references can be checked. */
  resourceIds: ReadonlySet<string>
  now: Date
  /** Does this code exist in the terminology store? Omitted when no store is available. */
  isKnownCode?: (system: string, code: string) => Promise<boolean>
}

/** Checks resources and reports problems. It never changes a resource. */
export interface FhirValidator {
  validate(resources: readonly FhirResource[], context: ValidationContext): Promise<ValidationResult[]>
}

type Rec = Record<string, unknown>
const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmpty = (value: unknown): boolean => (typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null)

const FIXED_CODES = new Set([`${NO_KNOWN_ALLERGY.system}|${NO_KNOWN_ALLERGY.code}`, `${DISCHARGE_SUMMARY_LOINC.system}|${DISCHARGE_SUMMARY_LOINC.code}`])

const STATUS_VALUES: Record<string, readonly string[]> = {
  Encounter: ['finished', 'in-progress', 'planned', 'cancelled'],
  MedicationRequest: ['active', 'completed', 'stopped', 'cancelled', 'on-hold', 'draft'],
  Observation: ['final', 'amended', 'corrected', 'preliminary', 'registered'],
  Procedure: ['completed', 'in-progress', 'not-done', 'stopped'],
  DiagnosticReport: ['final', 'amended', 'corrected', 'preliminary', 'registered'],
}

const REQUIRED: Record<string, readonly string[]> = {
  Encounter: ['status', 'class', 'subject'],
  Condition: ['clinicalStatus', 'verificationStatus', 'code', 'subject'],
  MedicationRequest: ['status', 'intent', 'medicationCodeableConcept', 'subject'],
  AllergyIntolerance: ['clinicalStatus', 'verificationStatus', 'code', 'patient'],
  Observation: ['status', 'code', 'subject'],
  Procedure: ['status', 'code', 'subject'],
  DiagnosticReport: ['status', 'code', 'subject'],
}

const DATE_FIELDS: Record<string, readonly string[]> = {
  Condition: ['onsetDateTime'],
  Observation: ['effectiveDateTime'],
  Procedure: ['performedDateTime'],
}

const DATE_PATTERN = /^\d{4}(-\d{2}(-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?)?)?$/

function collectCodings(node: unknown, path: string, out: { path: string; system: unknown; code: unknown }[]): void {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => collectCodings(entry, `${path}[${index}]`, out))
    return
  }
  if (!isRec(node)) return
  if (Array.isArray(node.coding)) {
    node.coding.forEach((coding, index) => {
      if (isRec(coding)) out.push({ path: `${path}.coding[${index}]`, system: coding.system, code: coding.code })
    })
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'coding') collectCodings(value, path ? `${path}.${key}` : key, out)
  }
}

export class NodeFhirValidator implements FhirValidator {
  async validate(resources: readonly FhirResource[], context: ValidationContext): Promise<ValidationResult[]> {
    const results: ValidationResult[] = []
    for (const resource of resources) {
      const issues = await this.check(resource, context)
      results.push({
        resourceId: resource.id,
        status: issues.some((issue) => issue.severity === 'error') ? 'fail' : 'pass',
        issues,
      })
    }
    return results
  }

  private async check(resource: FhirResource, ctx: ValidationContext): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = []
    const add = (code: ValidationIssue['code'], path: string, message: string, ruleId: string, severity: IssueSeverity = 'error') =>
      issues.push({ severity, code, path, message, ruleId })
    const type = resource.resourceType
    const body = resource as Rec

    for (const field of REQUIRED[type] ?? []) {
      if (!nonEmpty(body[field])) add('required', field, `${type}.${field} is required`, `${type}.${field}.required`)
    }

    const allowedStatus = STATUS_VALUES[type]
    if (allowedStatus && nonEmpty(body.status) && !allowedStatus.includes(String(body.status))) {
      add('invalid_value', 'status', `"${String(body.status)}" is not a valid ${type} status`, `${type}.status.value`)
    }

    this.checkReferences(body, ctx, add)
    this.checkCodings(body, add)
    await this.checkKnownCodes(body, ctx, add)
    this.checkDates(body, type, ctx.now, add)
    this.checkTypeRules(body, type, add)
    return issues
  }

  private checkReferences(body: Rec, ctx: ValidationContext, add: (...args: [ValidationIssue['code'], string, string, string, IssueSeverity?]) => unknown) {
    const subject = (isRec(body.subject) ? body.subject : isRec(body.patient) ? body.patient : undefined)?.reference
    if (nonEmpty(subject) && subject !== `Patient/${ctx.patientId}`) {
      add('invalid_reference', 'subject', 'The patient reference does not match the record patient', 'reference.patient')
    }
    const targets: [string, unknown][] = []
    if (isRec(body.encounter)) targets.push(['encounter', body.encounter.reference])
    if (Array.isArray(body.result)) body.result.forEach((entry, index) => isRec(entry) && targets.push([`result[${index}]`, entry.reference]))
    for (const [path, reference] of targets) {
      const id = typeof reference === 'string' ? reference.split('/')[1] : undefined
      if (!id || !ctx.resourceIds.has(id)) add('invalid_reference', path, `${path} points at a resource that is not part of this record`, 'reference.target')
    }
  }

  private checkCodings(body: Rec, add: (...args: [ValidationIssue['code'], string, string, string, IssueSeverity?]) => unknown) {
    const codings: { path: string; system: unknown; code: unknown }[] = []
    collectCodings(body, '', codings)
    for (const coding of codings) {
      if (typeof coding.system !== 'string' || !ALLOWED_CODE_SYSTEMS.includes(coding.system)) {
        add('invalid_code', coding.path, `Code system "${String(coding.system)}" is not allowed`, 'coding.system')
      }
      if (typeof coding.code !== 'string' || coding.code.trim() === '') add('invalid_code', coding.path, 'A coding has no code', 'coding.code')
    }
  }

  private async checkKnownCodes(body: Rec, ctx: ValidationContext, add: (...args: [ValidationIssue['code'], string, string, string, IssueSeverity?]) => unknown) {
    if (!ctx.isKnownCode) return
    const codings: { path: string; system: unknown; code: unknown }[] = []
    collectCodings(body, '', codings)
    for (const { path, system, code } of codings) {
      if (typeof system !== 'string' || typeof code !== 'string') continue
      if (![SYSTEM.snomed, SYSTEM.loinc, SYSTEM.icd10].includes(system as never) || FIXED_CODES.has(`${system}|${code}`)) continue
      if (!(await ctx.isKnownCode(system, code))) add('invalid_code', path, `Code ${code} does not exist in the terminology`, 'coding.exists')
    }
  }

  private checkDates(body: Rec, type: string, now: Date, add: (...args: [ValidationIssue['code'], string, string, string, IssueSeverity?]) => unknown) {
    const check = (path: string, value: unknown) => {
      if (!nonEmpty(value)) return
      if (typeof value !== 'string' || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
        add('invalid_value', path, `${path} is not a valid FHIR date`, 'date.format')
        return
      }
      if (Number(value.slice(0, 4)) < 1900) add('implausible', path, `${path} is before 1900`, 'date.floor')
      if (Date.parse(value) > now.getTime()) add('implausible', path, `${path} is in the future`, 'date.future')
    }
    for (const field of DATE_FIELDS[type] ?? []) check(field, body[field])
    if (type === 'Encounter' && isRec(body.period)) {
      check('period.start', body.period.start)
      check('period.end', body.period.end)
      if (typeof body.period.start === 'string' && typeof body.period.end === 'string' && Date.parse(body.period.end) < Date.parse(body.period.start)) {
        add('implausible', 'period.end', 'The discharge date is before the admission date', 'date.order')
      }
    }
  }

  private checkTypeRules(body: Rec, type: string, add: (...args: [ValidationIssue['code'], string, string, string, IssueSeverity?]) => unknown) {
    if (type === 'MedicationRequest' && Array.isArray(body.dosageInstruction)) {
      body.dosageInstruction.forEach((dosage, index) => {
        if (!isRec(dosage) || !Array.isArray(dosage.doseAndRate)) return
        for (const entry of dosage.doseAndRate) {
          const quantities = isRec(entry) ? [entry.doseQuantity, isRec(entry.doseRange) ? entry.doseRange.low : undefined, isRec(entry.doseRange) ? entry.doseRange.high : undefined] : []
          for (const quantity of quantities) {
            if (isRec(quantity) && !(typeof quantity.value === 'number' && quantity.value > 0)) {
              add('invalid_value', `dosageInstruction[${index}].doseAndRate`, 'A dose must be greater than zero', 'dose.positive')
            }
          }
        }
      })
    }
    if (type === 'Observation' && isRec(body.valueQuantity)) {
      if (typeof body.valueQuantity.value !== 'number' || !Number.isFinite(body.valueQuantity.value)) {
        add('invalid_value', 'valueQuantity.value', 'An observation value must be a finite number', 'observation.value')
      }
    }
    if (type === 'Observation' && !nonEmpty(body.valueQuantity) && !nonEmpty(body.valueString)) {
      add('required', 'value[x]', 'An observation needs a value', 'Observation.value.required')
    }
  }
}

/** Service mode (an external HL7 validator with national profiles) is not shipped: fail closed, never skip validation. */
export function getFhirValidator(mode: 'node' | 'service' = getEnv().FHIR_VALIDATOR_MODE): FhirValidator {
  if (mode === 'node') return new NodeFhirValidator()
  throw new AppError('INTERNAL', 'FHIR_VALIDATOR_MODE=service is not available in this build', { retryable: false })
}
