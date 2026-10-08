# Spec 10 — Commit to Storage, Provenance, Immutable Audit Log, FHIR Read [MVP] (Component 8, FR9, US-008)

> **Implementation status (Feature 10).** Built: stage `commit` (`stages/commit.ts`) and `commit/commitErrors.ts`. Before calling `commit_record` it re-asks the consent ledger when the stored answer is over 24 hours old (shared helper `consent/runCheck.ts`), re-checks the source switch and the global kill switch, and verifies the decision checksum. `routing` may now move to `blocked_consent` (stale re-check found consent revoked). Audit reconstruction, the FHIR read API and the record page were added in Feature 12: `audit/reconstruct.ts` (`GET /api/audit/records/:id`, admin only, audited as `audit.reconstructed`), `fhir/{fhirRead,provenance}.ts` (`GET /api/fhir/:type/:id`, search by `patient`/`record`, `/api/fhir/Provenance/:id`; unsupported parameters are 422), `records/traceService.ts` (`GET /api/ingestions/:id/trace`), and the `/records` and `/records/[id]` pages with `AuditTimeline` and `ProvenanceCard`. Reads of FHIR resources are not audited (only document access is). Error responses use the standard JSON envelope, not an OperationOutcome.

## 1. Goal
Persist every auto-committed and human-approved resource atomically with full provenance, and keep an immutable, tamper-evident audit trail that lets a compliance officer reconstruct why any record was or wasn't auto-committed.

## 2. Commit
Implemented by SQL function `public.commit_record(record_id, mode, reviewer_id)` (see schema §11), invoked through `supabaseAdmin.rpc('commit_record', {...})` only from:
- `stages/commit.ts` (mode `auto`), and
- the review submit handler (mode `human`).

Guarantees enforced **in the database**:
1. Row lock on the record; refuses if already committed.
2. Consent check row must be `valid`.
3. `auto`: routing decision is `auto_commit` and record status is `routing`; no found-but-ungrounded fields.
4. `human`: a completed review task exists and a reviewer id is supplied.
5. All `mapped_resources` have `validation_status='pass'` and at least one resource exists.
6. Inserts `fhir_resources` (id = `mapped_resources.id`, `ai_extracted=true`, `commit_mode`), one `provenance` row per resource, sets record `auto_committed` or `committed`, `completed_at`, `latency_ms`, and appends audit `record.committed` — **all in one transaction**; any exception rolls everything back.
Exceptions are surfaced as stable codes (`consent_not_valid`, `validation_not_passed`, …) mapped by `commitErrorToAppError()` to `CONFLICT`/`INTERNAL`; stage handler converts to `needs_review` (`stage_error:commit`) after one retry.

Commit-stage extras (before calling RPC, in app code): re-check `source.auto_commit_enabled` (abort `source_paused`); re-run consent `verify` if `consent_checks.checked_at` older than 24 h (spec 05 §6); verify `routing_decisions` still match (checksum of `thresholds_applied`).

## 3. Provenance (what is stored and shown)
`provenance` row per committed resource:
- `extraction_method`: `ai_extracted_auto` | `ai_extracted_human_reviewed`
- `model_id`, `prompt_set` (versions of extraction/mapping/scoring prompts)
- `consent_artifact_id` (+ artifact ref via join)
- `reviewer_id` (human mode)
- `field_provenance`: `{field_key: {span:{page,quote,bbox,...}, confidence, basis}}`; reviewer-supplied values carry `{reviewer_supplied:true}`
- `committed_at`; source id; record id
FHIR representation: `GET /api/fhir/{type}/{id}?_include=Provenance` returns the resource plus a FHIR `Provenance` resource built on the fly (`target`, `recorded`, `agent` = device "AI extraction pipeline" and, for human mode, practitioner reference `reviewer`, `entity` = source document `DocumentReference` id, `entity.role='source'`, extension for confidence). The committed resource's `meta.tag` includes `ai-extracted` (spec 07) so downstream consumers see the AI origin.

## 4. Audit log
Table `audit_log` (append-only; trigger-enforced; hash chain per org). Details:
- Insert only through service role: `auditLog.append({orgId, recordId?, actor:{type,id}, event, payload})`. Failure to write an audit row for a **state-changing pipeline step** aborts that step (audit is part of the transaction when possible; otherwise stage throws retryable error). Audit writes for read events (`document.accessed`) are best-effort but logged to application logs on failure.
- Hash: `sha256(prev_hash | org_id | id | event | payload::text | created_at::text)`; `verify_audit_chain(org)` returns first broken id or null. A scheduled daily job (`/api/internal/audit/verify`, secret-protected) runs verification for each org and alerts on break.
- No UPDATE/DELETE/TRUNCATE (trigger). Retention: indefinite (min 7 years target); archival is out of scope.
- PHI rule: payloads contain ids/enums/numbers only (spec 00 §7); static test scans `payload` strings against a denylist regex for ABHA/phone/email patterns in CI (`audit-no-phi.test.ts`).

### Audit reconstruction ("why was this record committed/escalated")
`GET /api/audit/records/:id` returns the ordered chain joined with stage artifacts: consent result and artifact ref, OCR engine/confidence, extraction prompt version + counts, mapping/validation results, scores and thresholds (from `routing_decisions`), routing reasons + trace, review events and the diff (`review_corrections`), commit event with resource ids. Admin only.

## 5. API

| Method/Path | Roles | Request | Response | Errors |
|---|---|---|---|---|
| `POST /api/audit/search` | admin | JSON `{record_id?, source_id?, patient_identifier?:{type,value}, events?[], actor_id?, from?, to?, limit?, cursor?}` | `{data:[{id,created_at,actor_type,actor_id,actor_name,event,record_id,payload,hash_short,hash_ok}]}` | POST (not GET) so a patient identifier is never placed in a URL; identifier is matched by HMAC hash server-side and never returned or logged |
| `GET /api/audit/records/:id` | admin | — | reconstruction object above | 404 |
| `POST /api/audit/export` | admin | same filters as search + `format: 'csv'|'json'` (≤ 50,000 rows) | file download; audit `audit.exported` records the filter names, row count and format (never filter values) | 422 `TOO_MANY_ROWS` |
| `GET /api/audit/verify` | admin | — | `{ok:boolean, first_broken_id?}` | |
| `GET /api/fhir/:resourceType/:id` | IE, reviewer, admin | `?_include=Provenance` | FHIR JSON (`application/fhir+json`) | 404; 403 |
| `GET /api/fhir/:resourceType` | IE, admin | `?patient=<patient_uuid>&_count&_page` (only `patient` and `record` filters) | FHIR `Bundle` (searchset) | 422 unsupported param |
| `GET /api/fhir/Provenance/:resource_id` | IE, reviewer, admin | — | FHIR Provenance | 404 |

`hash_ok` is computed per page by recomputing hashes of returned rows against `prev_hash`; full-chain verification is `GET /api/audit/verify`.

## 6. UI
- `/audit`: filter bar (record id, source, event multi-select, date range, patient identifier field), results table (time, event, actor, record link), row drawer showing payload JSON. Button **Reconstruct record** opens `AuditTimeline` (vertical timeline, stage icons, expandable details, links to `/records/[id]`). Export button with confirm. Banner when chain verification fails ("Audit integrity check failed at event #… — contact security").
- `/records/[id]`: `ProvenanceCard` (method, model, prompt versions, consent ref, reviewer, timestamp) and an **AI-extracted** tag on every committed value; link "View audit trail" (admin).
- Downstream consumers of the FHIR read API are authenticated users only in MVP (no external FHIR endpoint).

## 7. Edge cases
- Commit partially fails (e.g. provenance insert error): whole transaction rolls back; record unchanged; stage retried once, then escalated.
- Duplicate commit invocation (retry after timeout): second call raises `already_committed`; handler treats it as success (idempotent) after verifying existing `fhir_resources` for the record.
- Record committed but audit insert fails: impossible by design (same transaction).
- Resource edits after commit: not supported in MVP; corrections to committed data are a new record version flow [ITER] — `fhir_resource_versions` trigger already archives prior versions if an admin tool updates `resource`.
- Retention/erasure requests (DPDP): out of scope for MVP; design note: erase by purging PHI columns while retaining hash-chained audit entries that contain no PHI.
- Admin exports with very large ranges: capped at 50,000 rows; stream response.
- Audit search by patient identifier: server computes HMAC and matches `patients.*_hash`, then filters records; identifier never stored in audit payload.

## 8. Acceptance criteria
1. Calling `commit_record` without a `valid` consent row, without a passing validation, or without an `auto_commit` decision fails and writes nothing (SQL tests).
2. Successful commit creates N `fhir_resources`, N `provenance`, updates record status and appends exactly one `record.committed` event — atomically (kill-connection test leaves no partial rows).
3. `UPDATE`/`DELETE`/`TRUNCATE` on `audit_log` raise an exception, even with the service role.
4. Tampering with one `audit_log.payload` via superuser SQL makes `verify_audit_chain` return that id.
5. For any committed or escalated record the reconstruction endpoint returns consent result, OCR confidence, extraction, validation, scores, thresholds, routing reasons and (if applicable) reviewer + diff — 100% of records in the E2E suite.
6. No audit payload in the test corpus matches the PHI denylist.
7. `GET /api/fhir/MedicationRequest/:id?_include=Provenance` returns resource + Provenance with `ai-extracted` tag and consent reference; viewer role gets 403.
8. Committing a record twice never creates duplicate resources.
