# Spec 00 — Overview, Shared Contracts and Conventions

Derived from `docs/engineering/engineering-doc.md`. Every other spec in `docs/specs/` assumes this file. Where specs conflict, this file wins.

## 1. Spec index

| File | Covers | PRD refs |
|---|---|---|
| `supabase-schema.sql` | Runnable DB schema, RLS, triggers, functions, storage | all |
| `../../.env.example` | Environment variables | all |
| `01-auth-roles-rls.md` | Auth, roles, middleware, user admin | personas |
| `02-sources-thresholds.md` | Provider sources, API keys, thresholds | FR7, US-006 |
| `03-ingestion-intake.md` | Submission API/UI, HL7v2, dedupe | FR1, US-001 |
| `04-pipeline-orchestration-normalization.md` | Job queue, state machine, OCR/normalization | Comp. 1 |
| `05-consent-gate.md` | Consent service (stub + ABDM) | FR2, US-002 |
| `06-grounded-extraction.md` | Extraction prompts, schema, grounding check | FR3, US-003 |
| `07-mapping-validation.md` | Terminology RAG, FHIR builders, validation | FR4–5, US-004 |
| `08-confidence-routing.md` | Scoring formula, routing rule | FR6–7, US-005–006 |
| `09-review-queue.md` | Review task lifecycle, API, workspace UI | FR8, US-007 |
| `10-commit-audit-provenance.md` | Commit function, audit chain, audit UI, FHIR read | FR9, US-008 |
| `11-frontend-app-shell.md` | Layout, design tokens usage, shared components, page states | all UI |
| `12-ai-evals-prompts.md` | Datasets, eval runners, prompt library, release gates | Eval Plan, Prompt Strategy |
| `13-calibration-metrics-dashboard.md` | Metrics, calibration, dashboard, alerts | FR10–11, US-009–010 |
| `14-safety-controls.md` | Pause/resume, downstream errors, holdback, rollback | Responsible AI |
| `15-testing-acceptance.md` | Test plan, acceptance matrix, traceability | all |
| `16-project-setup-deploy.md` | Dependencies, scripts, Netlify, seeding | all |

## 2. Release scoping used by all specs
Each requirement is tagged **[MVP]**, **[MVP1]**, **[GA]** or **[ITER]** (engineering doc §10). Code for later releases is not built early, but interfaces (e.g. `ConsentService`) are designed now.

## 3. Roles and permissions matrix (authoritative)

| Capability | integration_engineer | reviewer | admin | viewer |
|---|---|---|---|---|
| View dashboard/aggregate metrics | ✔ | ✔ | ✔ | ✔ |
| View records, fields, FHIR, documents (PHI) | ✔ | ✔ | ✔ | ✘ |
| Submit records | ✔ | ✘ | ✔ | ✘ |
| Create/edit sources, API keys (rotate: admin only) | ✔ | ✘ | ✔ | ✘ |
| Edit thresholds | ✔ | ✘ | ✔ | ✘ |
| Enable auto-commit | ✘ | ✘ | ✔ | ✘ |
| Pause source auto-commit | ✘ | ✘ | ✔ | ✘ |
| Claim/submit review tasks | ✘ | ✔ | ✘ (can release/reassign) | ✘ |
| Report downstream error | ✘ | ✔ | ✔ | ✘ |
| Flag source as poor | ✘ | ✔ | ✔ | ✘ |
| Search/export audit log | ✘ | ✘ | ✔ | ✘ |
| Manage users | ✘ | ✘ | ✔ | ✘ |
| Retry failed record | ✔ | ✘ | ✔ | ✘ |

Note: the engineering doc allowed viewers to see record metadata; this spec is stricter (viewers see aggregates only) because record rows contain patient-linked data. RLS enforces it.

## 4. Record state machine (single source of truth)

```
received → consent_check ─┬→ blocked_consent                    (terminal)
                          └→ normalizing ─┬→ needs_review (low_ocr_quality)
                                          └→ extracting → mapping → validating → scoring → routing
routing ─┬→ auto_committed                                      (terminal)
         └→ needs_review → in_review → committed | rejected      (terminal)
any stage after retry exhausted → needs_review (reason llm_error | stage_error)
unrecoverable (storage missing, corrupt file) → failed            (terminal; admin alert)
```
Allowed transitions are encoded in `src/server/pipeline/transitions.ts` as a `Record<RecordStatus, RecordStatus[]>` map; `setStatus()` throws `AppError('INVALID_TRANSITION')` otherwise and writes audit `record.status_changed`.

| From | Allowed to |
|---|---|
| received | consent_check, failed |
| consent_check | blocked_consent, normalizing, failed |
| normalizing | extracting, needs_review, failed |
| extracting | mapping, needs_review, failed |
| mapping | validating, needs_review, failed |
| validating | scoring, needs_review, failed |
| scoring | routing, needs_review, failed |
| routing | auto_committed, needs_review, failed |
| needs_review | in_review, rejected |
| in_review | committed, rejected, needs_review (lock expiry/release) |

## 5. Shared TypeScript contracts (`src/types/domain.ts`)

```ts
export type Role = 'integration_engineer' | 'reviewer' | 'admin' | 'viewer';
export type ResourceType = 'Condition' | 'MedicationRequest' | 'AllergyIntolerance' | 'Observation'
  | 'DiagnosticReport' | 'Encounter' | 'Procedure';           // MVP: first 6; Procedure optional
export type CodeSystem = 'snomed' | 'loinc' | 'icd10';
export const FHIR_SYSTEM_URI: Record<CodeSystem, string> = {
  snomed: 'http://snomed.info/sct', loinc: 'http://loinc.org', icd10: 'http://hl7.org/fhir/sid/icd-10',
};

export interface SourceSpan {
  page: number;                 // 1-based
  block_ids: string[];          // ids from documents.normalized_text blocks
  quote: string;                // verbatim substring of the page text, 1..500 chars
  char_start: number;           // offset in page text
  char_end: number;
  bbox?: [number, number, number, number]; // normalized 0..1 [x0,y0,x1,y1], union of blocks
}

export interface ExtractedField {
  field_key: string;            // e.g. "medication[0].dose" (see spec 06 §3)
  resource_type: ResourceType;
  value: unknown | null;        // null when found=false
  found: boolean;
  source_span: SourceSpan | null;   // required when found=true
  basis: 'stated' | 'inferred' | null;
  confidence: number;           // 0..1 model-reported
}

export interface Coding {
  field_key: string; system: CodeSystem; code: string; display: string;
  match_confidence: number; candidates: { code: string; display: string; score: number }[];
}

export interface RoutingDecision {
  record_id: string; aggregate_score: number;
  decision: 'auto_commit' | 'escalate';
  escalation_reasons: EscalationReason[];
  thresholds_applied: Record<string, { threshold: number; version: number; score: number; pass: boolean }>;
  validation_result: 'pass' | 'fail' | 'pending'; reasoning_trace: string; rule_version: string;
}
export type EscalationReason = 'below_threshold' | 'schema_invalid' | 'ungrounded' | 'low_ocr'
  | 'source_not_enabled' | 'holdback' | 'llm_error' | 'stage_error' | 'ambiguous_label' | 'uncoded' | 'low_ocr_quality';
```

## 6. API conventions (apply to every route)

- Base path `/api`. JSON, UTF-8, snake_case keys. Timestamps ISO-8601 UTC.
- Auth: `Authorization: Bearer <supabase access token>` (browser uses cookie session via `@supabase/ssr`; route handlers read the session from cookies). Feed ingestion alone also accepts `X-Source-Key`.
- Every handler is wrapped: `export const POST = route({ roles: [...], body: Schema, handler })` (`src/lib/api/route.ts`) which performs, in order: request id → rate limit → authn → role check → Zod parse → handler → error mapping → response envelope.
- Success: `{ "data": <T>, "meta"?: { "next_cursor"?: string } }`. Error: `{ "error": { "code": string, "message": string, "details"?: unknown, "request_id": string } }`.
- Error code → HTTP: `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `INVALID_TRANSITION` 409, `PAYLOAD_TOO_LARGE` 413, `UNSUPPORTED_MEDIA_TYPE` 415, `VALIDATION_FAILED` 422, `RATE_LIMITED` 429 (+`Retry-After`), `UPSTREAM_ERROR` 502, `INTERNAL` 500.
- Cursor pagination: `limit` (default 25, max 100), `cursor` = opaque base64 of `(created_at,id)`; sort `created_at desc`.
- The user-scoped Supabase client (RLS applies) is used for reads. The service-role client (`src/lib/supabase/admin.ts`, `import 'server-only'`) is used only for pipeline/worker writes, audit inserts, and privileged mutations **after** an explicit role check in the handler.
- Never log request bodies for ingestion/review routes. Log `{request_id, route, user_id, status, ms}` only.

## 7. Audit event catalog (`audit_log.event`)

`auth.login`, `auth.login_failed`, `user.created`, `user.role_changed`, `source.created`, `source.updated`, `source.key_rotated`, `source.paused`, `source.resumed`, `source.auto_commit_enabled`, `threshold.changed`, `ingest.received`, `ingest.duplicate`, `record.status_changed`, `consent.checked`, `consent.blocked`, `consent.artifact_created`, `consent.artifact_updated`, `ocr.completed`, `ocr.rejected_low_quality`, `extraction.completed`, `mapping.completed`, `validation.completed`, `scoring.completed`, `routing.decided`, `review.claimed`, `review.released`, `review.submitted`, `record.committed`, `record.rejected`, `document.accessed`, `audit.exported`, `error.reported`, `calibration.proposed`, `calibration.applied`, `prompt.activated`, `prompt.rolled_back`, `worker.job_failed`.
Payload rules: ids, enums, numbers and reason codes only. **No PHI values** (no patient identifiers, field values, document text) in audit payloads; reference by `record_id`/`field_key`. Review diffs are stored in `review_corrections`, not in the audit payload.
Writing: `await audit({ orgId, recordId, actor, event, payload })` from `src/server/services/audit/auditLog.ts`; insert via service role; the DB trigger computes hashes.

## 8. Constants (`src/server/config/constants.ts`, values read from env with these defaults)

| Constant | Default | Env |
|---|---|---|
| `OCR_CONFIDENCE_FLOOR` | 0.80 | `OCR_CONFIDENCE_FLOOR` |
| `DEFAULT_THRESHOLD` | 0.97 | `DEFAULT_THRESHOLD` |
| `HIGH_RISK_THRESHOLD` (MedicationRequest, AllergyIntolerance, lab Observation) | 0.99 | `MEDICATION_ALLERGY_THRESHOLD` |
| `INFERRED_SCORE_CAP` | 0.80 | — |
| `LOW_OCR_SPAN_CAP` | 0.75 | — |
| `SCORE_WEIGHTS` | `{e:0.5, m:0.3, v:0.2}` | — |
| `AGG_BLEND` | `{min:0.7, mean:0.3}` | — |
| `JOB_MAX_ATTEMPTS` | 2 | `JOB_MAX_ATTEMPTS` |
| `REVIEW_LOCK_MINUTES` | 30 | `REVIEW_LOCK_MINUTES` |
| `MAX_UPLOAD_BYTES` | 26214400 | `MAX_UPLOAD_BYTES` |
| `HOLDBACK_PCT_DEFAULT` | 10 | `HOLDBACK_PCT_DEFAULT` |
| `ROUTING_RULE_VERSION` | `"route-v1"` | — |

`src/server/config/env.ts` parses `process.env` with Zod at module load; missing/invalid required variables throw at boot (server) so misconfiguration fails fast.

## 9. Definition of done (all features)
1. Zod schema + TS types; 2. migrations/SQL applied; 3. service with unit tests; 4. route handler with integration tests (authz matrix + validation + happy path); 5. UI with loading/empty/error states and keyboard access; 6. audit events emitted; 7. no PHI in logs; 8. acceptance criteria in the feature's spec pass.
