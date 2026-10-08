# Spec 05 — Consent-Scoped Access Gating [MVP stub; MVP1 ABDM sandbox; ITER HIPAA] (FR2, US-002)

## 1. Goal
Before any OCR or LLM touches a document, verify that a valid consent artifact covers every data category being ingested for the patient. Missing/expired/revoked/out-of-scope consent is a hard block. The decision is deterministic, binary and fully logged.

## 2. Interface (`src/server/services/consent/ConsentService.ts`)
```ts
export interface ConsentQuery {
  orgId: string; sourceId: string; patientId: string;
  regime: 'abdm' | 'hipaa';
  requiredCategories: string[];     // from ingestion_records.data_categories
  at: Date;                         // evaluation time (now)
}
export interface ConsentVerdict {
  result: 'valid'|'missing'|'expired'|'revoked'|'out_of_scope'|'error';
  artifactId?: string;              // consent_artifacts.id of the artifact that satisfied the check
  artifactRef?: string;             // external id (ABDM consent id)
  matchedScope: string[];
  detail: Record<string, unknown>;  // no PHI
}
export interface ConsentService { verify(q: ConsentQuery): Promise<ConsentVerdict> }
```
Factory `getConsentService()` returns `StubConsentLedger` if `CONSENT_MODE=stub`, `AbdmConsentManagerClient` if `abdm`. The HIPAA implementation `HipaaAuthorizationService` is added in [ITER] behind the same interface.

## 3. Matching rules (identical for every implementation)
Evaluate all artifacts for `patientId` + `regime`:
1. No artifacts → `missing`.
2. Consider artifacts with `status='granted'` and `valid_from ≤ at ≤ valid_to`. If none but some are `revoked` → `revoked` (if the most recent artifact is revoked); else if some exist but all `valid_to < at` → `expired`.
3. Among active artifacts, **a single artifact must cover all `requiredCategories`** (`required ⊆ artifact.categories`). If the union of artifacts covers them but no single artifact does → `out_of_scope` (conservative: no stitching across artifacts).
4. If `requiredCategories` is empty → `out_of_scope` (cannot happen via API; defensive).
5. Multiple qualifying artifacts → choose the one with the latest `valid_to`; ties → latest `created_at`.
6. If the artifact's `hip_id` is set and does not match the source's registered `hip_id`/name mapping → `out_of_scope` (MVP1: compare `provider_sources.hip_id`; column added in the MVP1 migration; skipped in MVP).
7. Any exception, timeout (5 s), or malformed ledger response → `error` (fail closed; treated as block).
Evaluation is purely a function of ledger state + time; no ML.

## 4. Stub ledger [MVP]
`StubConsentLedger` reads `consent_artifacts` in Supabase. Admin-only seeding endpoints (non-production flag `CONSENT_MODE=stub` only; return 404 when mode is `abdm`):
- `POST /api/admin/consent-artifacts` — `{patient_identifier, artifact_ref, categories[], valid_from, valid_to, status?}` → creates/links patient and artifact. Validation: `valid_to > valid_from`, categories subset of allowed ABDM HI types.
- `PATCH /api/admin/consent-artifacts/:id` — set `status` (`granted|revoked`) to simulate revocation.
- `GET /api/admin/consent-artifacts?patient_identifier=` — list.
UI: `/admin/consent` (stub mode only) with a table and "Add consent" dialog so QA can craft missing/expired/revoked/out-of-scope cases.

## 5. ABDM Consent Manager client [MVP1]
`AbdmConsentManagerClient.verify` calls the ABDM sandbox Consent Manager/gateway (`ABDM_BASE_URL`, OAuth client credentials `ABDM_CLIENT_ID/SECRET`) to fetch the consent artifact(s) for the patient's ABHA and the HIP/HIU context, maps the response to the matching rules, and upserts a mirror row into `consent_artifacts` (`raw` jsonb for evidence). Token cached in memory until expiry − 60 s. Calls have 5 s timeout, no retry inside `verify` (the stage job retry covers it once; a persistent `error` blocks). The exact artifact schema and scope mapping are validated against ABDM documentation and reviewed by compliance before MVP1 sign-off (engineering doc Appendix A #5). The matching rules in §3 do not change.

## 6. Consent stage (`stages/consentCheck.ts`)
1. Load record, patient, source; set status `consent_check`.
2. `verdict = await consent.verify(...)`.
3. Upsert `consent_checks` (unique `record_id`): `result, artifact_id, required_categories, matched_scope, regime, detail`.
4. Audit `consent.checked` `{result, artifact_ref?}`.
5. `valid` → enqueue `normalize`. Anything else → `setStatus('blocked_consent', result)`; audit `consent.blocked`; notify admins (in-app notification row via `audit` + `ALERT_WEBHOOK_URL` message with record id and reason only); **no further jobs**; no OCR/LLM calls; the stored document is not accessible through `GET …/document`.
6. `error` verdict: job retried once (stage retry policy); if still `error` → record `failed` with `status_reason='consent_service_error'` (blocked, alerts admin). It must never proceed.

Re-checking: consent is checked once at ingestion start and **again at commit** by `commit_record()` (SQL asserts the stored `consent_checks.result='valid'`). Additionally the commit stage re-calls `verify` if more than 24 h passed since `consent_checks.checked_at` (records waiting in review queue); if the result is no longer `valid` the record becomes `blocked_consent` and the draft is purged (see edge cases).

## 7. UI surfaces
- Record detail: `ConsentCard` shows result, artifact ref, matched scope, valid window, regime. Blocked records show red banner with a plain-language reason mapping: missing → "No consent on file for this patient"; expired → "Consent expired on <date>"; revoked → "Consent was revoked"; out_of_scope → "Consent does not cover: <categories>"; error → "Consent service unavailable".
- `/records` filter chip "Blocked (consent)".
- Admin notification list on dashboard "Consent blocks (last 7 days)".

## 8. Edge cases
- **Consent revoked while record is in review queue:** on claim/submit and at commit, if `verify` result ≠ `valid` the submit returns 409 `CONSENT_NO_LONGER_VALID`; record → `blocked_consent`; extracted fields, mapped resources and page images for that record are deleted (service function `purgeRecordPHI(recordId)`) while the audit trail remains.
- Consent expires exactly at `valid_to`: inclusive of `valid_to` instant (`at <= valid_to`).
- Patient has two artifacts, each covering only one required category → `out_of_scope` (no stitching).
- Clock skew: use database `now()` for evaluation, not application time, in the stub.
- Patient identifier re-used across sources: patients are scoped per org/ABHA (ABHA unique per org) so consent applies across sources of the same org; MRN-only patients are scoped to the source.
- Race: consent added after a block → user must resubmit (new record); the blocked record is terminal and does not participate in content dedupe (§10).
- Ledger outage: all new records fail closed (`failed`/blocked), dashboard banner "Consent service degraded".

## 9. Acceptance criteria
1. Adversarial test set (missing, expired, revoked, out-of-scope, two partial artifacts, malformed ledger response, timeout) → 100% blocked; **0 OCR/LLM/storage-read calls** for each (spy assertions).
2. Valid artifact covering required categories → record proceeds to `normalize` and `consent_checks` stores artifact id and matched scope.
3. Every consent decision (allow or block) has an audit event with result and artifact ref.
4. Commit of a record whose `consent_checks.result≠'valid'` fails in SQL (`consent_not_valid`).
5. Revocation during review blocks commit and purges draft PHI.
6. Stub endpoints are unavailable (404) when `CONSENT_MODE=abdm`.

## 10. Schema note
`ingestion_records` content uniqueness is a partial unique index (`uq_ingestion_content … where status <> 'blocked_consent'`) so a previously blocked document can be resubmitted after consent is fixed. The dedupe lookup in spec 03 §3 step 5 applies the same `status <> 'blocked_consent'` filter. MVP1 adds `provider_sources.hip_id text` (migration `0008_source_hip_id.sql`) for matching rule 6.
