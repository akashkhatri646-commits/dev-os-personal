# Spec 07 — Standards Mapping and FHIR Schema Validation [MVP] (Component 4, FR4–5, US-004)

> **Implementation status (Feature 9).** Built: `fhir/builders.ts`, `fhir/validator.ts` (`NodeFhirValidator` behind `FhirValidator`), `terminology/{search,dictionary}.ts` (lexical fallback until embeddings exist), `mapping/{entities,map,schema,prompt}.ts`, stages `map` and `validate`. Differences from the text below: the model answers with a candidate **id** (never a code); each system is a separate item (`<field_key>` and `<field_key>#2` for ICD-10); a failed resource does not stop the pipeline, it carries its issues to scoring/routing; a held mapping uses the reason `mapping_unavailable`. Not built: service-mode validation with ABDM profiles, embeddings client, terminology seed data.

## 1. Goal
Turn grounded fields into FHIR R4 resources with SNOMED CT / LOINC / ICD-10 coding chosen **from retrieved candidates** (never recalled), then validate every resource against its profile. Invalid or incomplete resources can never auto-commit.

## 2. Resource build plan (MVP)

| Resource | Built from | Required elements (completeness check) | Code systems |
|---|---|---|---|
| `Encounter` | `encounter.*` | `status=finished`, `class`, `subject`, `period.start`, `period.end` | `class` via `http://terminology.hl7.org/CodeSystem/v3-ActCode` (IMP/AMB) |
| `Condition` | `diagnosis[i].*` | `code`, `subject`, `encounter`, `clinicalStatus`, `verificationStatus` | SNOMED CT (primary), ICD-10 (secondary `coding`) |
| `MedicationRequest` | `medication[i].*` (phase=discharge) | `status=active`, `intent=order`, `medicationCodeableConcept` (SNOMED CT; brand/generic text preserved), `subject`, `encounter`, `dosageInstruction[0].text` + structured `doseAndRate` (value+unit), `timing.repeat` | SNOMED CT; units UCUM |
| `AllergyIntolerance` | `allergy[i].*` | `code`, `patient`, `clinicalStatus` | SNOMED CT |
| `Observation` | `lab[i].*` | `status=final`, `code` (LOINC), `subject`, `valueQuantity` (value + UCUM unit) or `valueString`, `effectiveDateTime` when present | LOINC |
| `DiagnosticReport` | `report.*` + links | `status=final`, `code`, `subject`, `result[]` refs | LOINC (e.g. 18842-5 Discharge summary) |
| `Procedure` | `procedure[i].*` (optional MVP) | `status=completed`, `code`, `subject` | SNOMED CT |

Reference wiring: all resources reference `Patient/{patient_id}` (logical id = `patients.id`; no demographic Patient resource is created in MVP) and `Encounter/{encounter_id}`. The builder sets `resource.id = mapped_resources.id` (UUID assigned when the row is created) and uses those ids in references, so references are valid at validation time and remain valid after commit (§9).
Profiles: base R4 plus ABDM implementation guide profiles (`https://nrces.in/ndhm/fhir/r4/StructureDefinition/<Resource>`) where available; `mapped_resources.profile_url` records the profile used. Meta: `meta.profile`, `meta.tag` `{system:'urn:health-ingest:provenance', code:'ai-extracted'}`.

## 3. Mapping stage (`stages/map.ts`)
For each codeable field (`diagnosis.text`, `medication.name`, `allergy.substance`, `lab.test_name`, `procedure.name`, `report.title`):
1. **Normalize query:** expand known abbreviations and Indian brand→generic via `knowledge_docs` (`drug_brand_map`, `abbreviation`) deterministically (dictionary lookup) before retrieval; keep original text in the resource `.text`.
2. **Retrieve candidates:** embed the normalized query (OpenAI embeddings at 1024 dimensions via the `dimensions` parameter, model from `EMBEDDINGS_MODEL`) and call `search_terminology(embedding, text, system, resource_type, 10)` (hybrid vector + trigram). System per resource type: Condition → snomed (also icd10 pass), MedicationRequest/AllergyIntolerance/Procedure → snomed, Observation/DiagnosticReport → loinc.
3. **LLM selection** (component `mapping`, tool `select_code`): input = source quote, original value, candidate list (id, code, display, score). Output `{field_key, selected: {code_system, code, display} | null, match_confidence 0..1, rationale ≤ 200 chars}`. Rules in prompt: choose only from candidates; return `null` if none is an exact semantic match (no "close enough" for medications/allergies); prefer the most specific candidate that is fully supported by the text.
4. **Verification (deterministic):** selected `(system, code)` must exist in `terminology_concepts` and be among the supplied candidates; else treated as `null` and flagged `invalid_code_selection`.
5. If `null` → resource is still built with `text` only (no coding), `uncoded` escalation reason, `match_confidence=0`.
6. Dual coding: Condition gets SNOMED `coding[0]`; if an ICD-10 candidate ≥ 0.85 retrieved and selected by the model's second call, it is appended as `coding[1]`. ICD absence is not an error.
7. Persist `mapped_resources.codings` with `candidates` (top 5, code+display+score only).

Batching: one LLM call per resource type group (all medications together, etc.) to reduce cost; each field receives its own result; call size ≤ 40 fields.

## 4. Build functions (`src/server/services/fhir/builders/*.ts`)
Pure TypeScript, unit-tested, one file per resource: `buildCondition(fields, codings, ctx) → fhir4.Condition`. Rules:
- Dates: `YYYY-MM-DD` or `YYYY-MM`/`YYYY` as given (no invention of day/month).
- Dose: `dosageInstruction[0] = {text: original quote, doseAndRate:[{doseQuantity:{value, unit, system:'http://unitsofmeasure.org', code: ucum}}], timing:{repeat:{frequency, period, periodUnit}}, route: {coding:[SNOMED route]}}` — structured timing only when frequency alias is recognized; otherwise only `text` and the resource is marked `incomplete_timing` (escalates, see below).
- UCUM mapping table `ucum.ts` (`mg→mg`, `mcg/µg→ug`, `ml→mL`, `IU→[IU]`, `tab/tablet→{tbl}` etc.); unknown unit → `unit` kept as string, no `code`, resource flagged `unit_unmapped` (escalates).
- `status`, `intent`, and other required elements are deterministic constants, never model output.
- `id` = pre-assigned UUID (`mapped_resources.id`); references use `ResourceType/{uuid}`.
- Extension `https://health-ingest.example/StructureDefinition/source-span` on each element is **not** added to the resource (spans live in `provenance`).

## 5. Special cases
- **NKDA:** only if the document explicitly states "no known allergies" (field `allergy_status` found, grounded): create `AllergyIntolerance` with code SNOMED `716186003` "No known allergy" and `verificationStatus=confirmed`; forced `HIGH_RISK_THRESHOLD`.
- **Brand names:** `medicationCodeableConcept.text` keeps the printed brand; code is the generic/clinical drug concept from the mapping step; `knowledge_docs drug_brand_map` match is shown in the trace.
- **Combination drugs:** no splitting in MVP; if `name` contains `+`/`/` and no combination concept is selected → `uncoded`.
- **Observations without numeric value:** `valueString` and `interpretation` only; `unit` absent allowed.

## 6. Validation stage (`stages/validate.ts`)
Order:
1. **Structural pre-check (own code):** required elements from §2 present; code systems from allowed list; no empty strings; reference targets exist; dates plausible (`≤ today`, `discharge ≥ admission`, no year < 1900); numeric dose > 0.
2. **FHIR profile validation** via `FhirValidator` interface:
   ```ts
   interface FhirValidator { validate(resource: object, profileUrl?: string): Promise<{ valid: boolean; issues: { severity: 'error'|'warning'; code: string; path: string; message: string; ruleId?: string }[] }> }
   ```
   `FHIR_VALIDATOR_MODE=node` → in-process validation using R4 StructureDefinitions + ABDM profiles via `fhirpath` / structural checks (`fhir-validator` equivalent); `service` → POST to the HAPI/HL7 validator service (`FHIR_VALIDATOR_URL`). Both return the same shape. Timeout 20 s → retryable error.
3. A resource is `pass` only with **zero `error` issues** and complete pre-check; warnings are stored. Result written to `mapped_resources.validation_status` and `validation_issues` (each issue names the failing profile rule — satisfies "cites the specific FHIR profile rule violated").
4. Any `fail` → record continues to scoring (so the reviewer sees a score) but routing will escalate (`schema_invalid`). Validation never silently repairs resources.
5. Terminology binding checks: coded elements must use a code that exists in the local terminology table (guards stale/invalid codes).
Audit: `mapping.completed` `{resources, uncoded, invalid_code_selection}`, `validation.completed` `{pass, fail}`.

## 7. UI
Record detail shows each resource card: type, status chip (Valid / Invalid with expandable issues), codings with system chips and candidate dropdown (reviewer), raw FHIR JSON toggle (read-only monospace, no HTML rendering). Invalid issues list shows `path` and rule message.

## 8. Edge cases
- Code retired/inactive: terminology seed includes only active concepts; search never returns inactive codes.
- Two equally good candidates: model must select one with `match_confidence ≤ 0.6` → below any threshold → escalate; both candidates shown to reviewer.
- Empty retrieval (no candidates ≥ 0.4 similarity) → `uncoded` without calling the LLM.
- Terminology gaps for rare specialties: mapping confidence tracked by resource type (spec 13) to surface bias.
- Resource references to a missing `Encounter` (encounter fields not found) → `Condition.encounter` omitted only if profile allows; otherwise validation fails → escalate.
- Validator service down: retry once; then `needs_review` (`stage_error:validate`).
- Embedding API failure: lexical-only fallback with `match_confidence` capped at 0.7.

## 9. Commit-time identity
`commit_record` (schema §11) sets `fhir_resources.id = mapped_resources.id` and writes it into `resource.id`, so the ids used in references during mapping/validation are the committed ids. Re-mapping a record (retry) deletes and recreates its `mapped_resources` rows before any commit, so ids are never reused across different content.

## 10. Acceptance criteria
1. Every committed resource has `validation_status='pass'` and, for coded elements, a `(system, code)` that exists in `terminology_concepts`.
2. A model-selected code not in the candidate list is rejected (`invalid_code_selection`) and the resource is left uncoded + escalated (unit test with a mocked LLM).
3. A Condition missing `subject` or a MedicationRequest missing dose value fails validation with the rule id and path.
4. Mapping exact-code match ≥ 95% on the labeled dev set (spec 12 gate).
5. Brand name "Glycomet 500" maps to the metformin concept and the printed brand remains in `.text`.
6. Unknown dose unit leaves `unit_unmapped` flag and routes to escalation.
7. Validation never alters the resource (checksum before/after identical).
