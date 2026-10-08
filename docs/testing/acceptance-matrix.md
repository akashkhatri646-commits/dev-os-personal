# Acceptance test matrix (Feature 14)

This maps each product requirement (spec 15 §9) to the tests that prove it, and says plainly what is
**automated and passing**, what **needs a real database or browser**, and what **is not built**. It is the
starting point for Stage 5 (full test suite) and for the launch checklist in spec 15 §10.

Status key: **Auto** = runs in `npm test` and passes today · **SQL** = `nextjs-app/tests/sql/acceptance.sql`, run once
in the Supabase SQL editor (written, not yet run) · **Live** = a step in `docs/verification-checklist.md` ·
**Gap** = not built yet.

## How the automated tests are organised

| Layer | Where | What it does |
|---|---|---|
| Unit | `tests/unit/*.test.ts` (50 files) | One module at a time: parsers, matching, grounding, builders, validator, scoring, routing, state machine, schemas, services with a mocked database. |
| Integration (in-process) | `tests/integration/*.test.ts` (4 files) | The **real** worker, stages, state machine, scoring, routing, validation, review, safety and read services run against an in-memory database (`tests/support/fakeDb.ts`). Only outside vendors (consent ledger, model, storage, terminology search) are replaced. |
| SQL | `tests/sql/acceptance.sql` | The database functions, constraints, audit immutability and row-level security, on a real database, inside a transaction that is rolled back. |
| Static security | `tests/integration/clientBoundary.test.ts`, `npm run check:bundle` | Server code and secrets cannot reach browser code; the built bundle contains no secret name or value. |

What the in-memory database does **not** prove: row-level security, triggers, and the SQL of `commit_record`,
`submit_review` and friends. Those are covered by `acceptance.sql`, which must be run against the real project.

## Requirement to test

| PRD item | Spec | Automated tests (Auto) | Still needed |
|---|---|---|---|
| FR1 / US-001 multi-format intake | 03, 04 | `ingestionService`, `parseSubmission`, `ingestionHelpers`, `hl7Parser`, `pdfText`, `normalizationHelpers`, `normalizeStage`; pipeline suite (text note end to end, wrong language) | Scanned PDF / fax / TIFF fixtures need the OCR adapter (Gap). Upload size and type spoofing beyond the unit cases: Live. |
| FR2 / US-002 consent gate | 05 | `consentEvaluate`, `consentService`, `consentCheckStage`, `consentPipeline`; pipeline suite "consent adversarial" (missing, expired, revoked, out of scope: 0 downloads, 0 model calls, no later job; ledger outage retried once then failed) | Real ABDM ledger (Gap, stub only). |
| FR3 / US-003 grounded extraction | 06 | `grounding`, `extractionRun`, `extractionSchemaAndPrompt`, `extractStage`; pipeline suite (every value has a proving span, hallucinated dose dropped and escalated, injected instruction never stored) | Evaluation set and F1 gate (spec 12): **Gap**. |
| FR4 / US-004 standards mapping | 07 | `mapping`, `fhirBuildersValidator`, `mapValidateStages`; pipeline suite (SNOMED chosen only from offered candidates, UCUM dose, timing, references) | Mapping accuracy eval: **Gap**. Terminology seed: Live. |
| FR5 schema and completeness validation | 07, 08 | `fhirBuildersValidator` (each rule, never mutates); pipeline suite (a record with an invalid resource cannot commit); `acceptance.sql` (`validation_not_passed`) | ABDM profile validation (service mode): Gap. |
| FR6 / US-005 confidence scoring | 08 | `scoringRouting` (formula, every cap, aggregation, edge cases); `routeCommitStages` | Calibration (identity only): Gap. |
| FR7 / US-006 threshold routing | 02, 08 | `scoringRouting` (truth table, each reason alone, threshold = exact pass, missing = 1.0, holdback ≈ 10 % over 2,000 draws); pipeline suite (source off, kill switch, holdback, low confidence, inferred "no known allergies") | None for MVP. |
| FR8 / US-007 review interface | 09 | `reviewPlan`, `reviewService`, `reviewDraft`; `review_safety` suite (correct one field → only it differs, one correction row per field, reviewer on provenance; invalid correction refused; claim conflict, claim limit, lock expiry, consent revoked mid-review → purge; audit sample hidden from reviewers) | Keyboard-only run and layout: Live; Playwright: Gap. |
| FR9 / US-008 audit and provenance | 10 | `auditQuery`, `assertNoPhi`, `fhirTraceReconstruct`; `review_safety` suite (reconstruction complete for committed and reviewed records, FHIR read with Provenance, other organisation → 404, no patient data in any audit payload across the flows); `acceptance.sql` (append-only, tamper detection, atomic commit) | Hash-chain tamper and immutability on a real database: SQL (not yet run). |
| FR10 / US-009 calibration | 13 | none | **Gap** (spec 13 not built). |
| FR11 / US-010 per-source visibility | 13 | none | **Gap** (dashboard not built). |
| US-011 lab reports (MVP1) | 06, 07, 12 | none | **Gap**. |
| US-012 HIPAA (ITER) | 05 | none | **Gap**. |
| Responsible AI: disclosure, oversight, recovery | 14 | `safetyControls`, `workerSafety`, `killSwitch`; `review_safety` suite (high error pauses the source, next record escalates `source_not_enabled`, resume blocked while an incident is open, in-flight commit re-checks a paused source, bulk review one task per record, pause all); pipeline suite (breaker holds jobs back, spend cap defers) | Breaker and spend cap against a real failing provider: Live (needs adapters). |
| Authorisation | 01 | `apiAuthz.matrix` (every route × every role; unauthenticated 401; each exported method must be listed); `pageAccess`, `route`, `authService` | RLS from a real session: SQL (viewer cannot read PHI tables). Cross-organisation 404 is checked per service in the integration suites. |
| Idempotency and concurrency | 03, 04 | pipeline suite (finished record untouched on re-run, two workers run each stage once, repeat commit never duplicates, extraction re-run replaces rows); `acceptance.sql` (`claim_jobs`, `already_committed`) | A worker killed mid-stage on a real database: Live. |
| Security baseline | 15 §8 | `clientBoundary`; `npm run check:bundle` (49 bundle files, 5 secret values from `.env.local`: nothing found); `workerAuth`, `rateLimit`, `sourceKeys`, `safeRedirect` | Zip/PDF bomb limits, SSRF review, dependency audit: Stage 7. |
| Performance and reliability | 15 §7 | none | **Gap** (k6 and soak need a deployed environment). |
| Accessibility and responsive | 15 §5.9–10 | none | **Gap** (needs a browser: axe via Playwright); manual steps in the checklist. |

## Spec acceptance criteria that are covered by an automated test

| Criterion | Test |
|---|---|
| Spec 08 §8.1 score computation exact | `scoringRouting` "gives a fully certain…", "applies the 0.5 / 0.3 / 0.2 weights", resource blend |
| 08 §8.2 inferred field ≤ 0.80 | "never lets an inferred field score above 0.80" |
| 08 §8.3 each reason forces escalation; auto-commit only when all clear | routing truth table (14 cases) |
| 08 §8.4 a decision row for every routed record | pipeline suite checks `routing_decisions` for committed and escalated records |
| 08 §8.5 holdback ≈ 10 % | "samples about 10 % of eligible records" |
| 08 §8.7 source with auto-commit off never commits | pipeline suite "escalates every record from a source without auto-commit" |
| 09 §10.1–2 one correction row per field, only the change differs | `review_safety` "lets a reviewer correct one field…" |
| 09 §10.3 invalid correction → 422, nothing committed | `review_safety` "refuses a correction that would make the resource invalid…" |
| 09 §10.5 lock semantics | `review_safety` "gives the second claimer a conflict…" |
| 09 §10.6 holdback tasks look like escalations | `review_safety` "hides an audit sample…" |
| 09 §10.8 audit events and provenance with reviewer | `review_safety` first review test |
| 10 §8.5 reconstruction complete | `review_safety` reconstruction tests |
| 10 §8.6 no PHI in audit payloads | pipeline suite and `review_safety` PHI scans |
| 10 §8.7 FHIR read with Provenance | `review_safety` "serves committed resources as FHIR…" |
| 10 §8.8 committing twice never duplicates | pipeline suite "never duplicates resources…" |
| 14 §9.1 high error pauses source, next record escalated | `review_safety` safety flow |
| 14 §9.2 resume blocked while incident open | same test (`OPEN_INCIDENT`) |
| 14 §9.3 kill switch: nothing auto-commits | pipeline suite "escalates every record when the global kill switch is off"; `killSwitch` |
| 14 §9.4 prompt rollback | `safetyControls` (`rollbackPrompt`) |
| 14 §9.6 breaker opens after 5 failures, jobs delayed not failed | `safetyControls`, `workerSafety`, pipeline suite |
| 14 §9.7 bulk review: one open task per record | `review_safety` "pauses every source…, one downstream review task per record" |
| 05 §9 consent adversarial: all blocked, spies at 0 | pipeline suite "consent adversarial suite" |

## Findings from writing these tests

1. **A record that states "no known allergies" can never auto-commit.** That statement is an enum, which
   extraction always marks as inferred, so its score is capped at 0.80, below any threshold above 0.80. This is
   conservative for a high-risk resource and is pinned by a test ("treats a stated 'no known allergies' as
   inferred"), but it means those records always go to review. Decide whether that is intended before the beta.
2. **While the circuit breaker is open a record can show "Processing (consent)" for a few minutes**, because its next
   job waits before its status moves on. The page banner explains the delay.
3. **The circuit breaker ignores reading text, HL7 and PDF text layers**, which use no provider, so they cannot close it.
4. **Language detection only tells English from Indian languages.** French or other European text is treated as English
   (the check is restricted to that candidate set on purpose). A test uses Hindi.
5. The database enforces that a source cannot have auto-commit on until its evaluation passed
   (`chk_source_autocommit_requires_eval`); `acceptance.sql` checks it.

## Known gaps, in the order they should be closed

1. Run `tests/sql/acceptance.sql` against the real project and fix anything it reports.
2. Playwright end-to-end scenarios and axe scans (spec 15 §5): login by role, ingest to record detail, review by keyboard, expired consent, admin pause, audit reconstruction and export, 375 px layout.
3. Provider adapters (OpenAI/Azure, OCR) and then the evaluation harness with labeled sets (spec 12) and its release gates.
4. Calibration and the dashboard (spec 13).
5. Coverage: `src/server` is at about 90 % of lines (target 85 %, met); `src/lib` is at about 79 % (target 80 %, just short), held down by browser-only code (`lib/supabase/*`, `lib/auth/withAuth.ts`) that needs a browser or a real session. 100 % branch coverage is not yet reached on the critical modules: `scoring` 97 %, `routing` 95 %, `consent matching` 95 %, `grounding` 82 %.
6. Load and soak tests (k6) once the app is deployed.
