# Spec 15 — Test Plan, Acceptance Matrix and Traceability

> **Implementation status (Feature 14).** Built: an in-memory database (`tests/support/fakeDb.ts`) and harness (`pipelineHarness.ts`, `fixtures.ts`) that let the real worker and services run in tests; integration suites `pipeline.acceptance`, `review_safety.acceptance`, `apiAuthz.matrix` and `clientBoundary` in `tests/integration/`; `tests/sql/acceptance.sql`; `scripts/check-bundle-secrets.mjs` (`npm run check:bundle`); and the traceability document `docs/testing/acceptance-matrix.md`. Differences from the plan above: integration tests use the in-memory database and not a local Supabase with MSW (so RLS and SQL are covered by `acceptance.sql` instead); fixtures are text notes (PDF, TIFF and HL7-with-Z-segment document fixtures wait for the OCR adapter); no Playwright, axe, k6 or pgTAP yet; coverage is about 90 % of `src/server` and 79 % of `src/lib`.

## 1. Tooling
| Layer | Tool | Location |
|---|---|---|
| Unit | Vitest | `tests/unit/**` (co-located fixtures in `tests/fixtures`) |
| Integration | Vitest + local Supabase (`supabase start`) + MSW for OCR/LLM/ABDM/embeddings/validator | `tests/integration/**` |
| E2E | Playwright (chromium + mobile viewport for non-review pages) + `@axe-core/playwright` | `tests/e2e/**` |
| SQL | pgTAP or Vitest with `pg` against local DB | `tests/sql/**` |
| AI evals | custom runners (spec 12) | `evals/**` |
| Perf | k6 (ingestion API) + custom pipeline soak | `tests/perf/**` |
Coverage targets: `src/server/**` ≥ 85% lines, `src/lib/**` ≥ 80%, components ≥ 70%; 100% branch coverage on `route.ts` (routing), `scoring`, `grounding`, `consent matching`. CI (`.github/workflows/ci.yml`): lint → typecheck → unit → integration → eval replay gate → E2E (on main and release branches).

## 2. Fixtures
- `tests/fixtures/documents/`: synthetic discharge summaries (digital PDF, scanned PDF, fax-quality TIFF, text note, HL7v2 with Z-segments), each with `*.expected.json`.
- `tests/fixtures/consent/`: artifacts for missing/expired/revoked/out-of-scope/stitching/valid.
- `tests/fixtures/llm/`: recorded LLM and OCR responses keyed by request hash (replay) plus malformed outputs (bad JSON, extra fields, hallucinated codes, injection obeyed, fabricated dose).
- Seed script `scripts/seed-test.ts`: org, 4 users (one per role), one source, thresholds, consent artifacts, prompt versions, small terminology subset (≥ 200 concepts incl. all codes in fixtures).

## 3. Unit tests (must exist)
| Area | Cases |
|---|---|
| Consent matching | each verdict path incl. no-stitching, inclusive `valid_to`, timeout→error |
| HL7 parser | escapes, repetitions, Z-segments, MLLP framing, batch split, malformed |
| Patient id | ABHA normalization/validation, HMAC/enc roundtrip |
| Grounding | exact/fuzzy/miss, numeric, dates (dd/mm), alias normalization, entity-quote coherence, injection phrases |
| Builders | each FHIR resource, UCUM mapping, partial dates, reference wiring |
| Scoring | formula, each cap, aggregation, rounding, calibration identity |
| Routing | truth table of all reasons, threshold precedence, missing threshold = 1.0, holdback roll distribution |
| Transitions | every allowed/disallowed state transition |
| Queue | backoff, attempts, dead-letter→review task |
| Auth | role matrix helper, lockout counter |
| Zod | each API schema valid/invalid |

## 4. Integration tests (must exist)
1. **API authz matrix:** every route × every role (generated table test) → expected 2xx/403/401; cross-org access → 404.
2. **RLS:** viewer cannot read PHI tables; org isolation; audit_log immutability even for service role; `commit_record` preconditions (each exception code).
3. **Pipeline happy path** (mocked vendors): upload → … → `auto_committed` when source enabled and scores high; `needs_review` otherwise; audit chain complete; resources valid.
4. **Consent adversarial:** all blocked; OCR/LLM/storage-read spies at 0 calls.
5. **Idempotency & concurrency:** double submit, duplicate content, two workers, killed worker mid-stage, repeat stage run.
6. **Failure handling:** LLM invalid JSON (repair then escalate), vendor 5xx (retry once then review), OCR low confidence (no LLM call), validator down.
7. **Review submit:** correction → revalidate → commit with reviewer provenance; invalid correction 422; lock expiry; consent revoked mid-review → purge.
8. **Safety:** downstream error auto-pause; kill switch; resume blocked while incident open.
9. **Audit:** reconstruction endpoint completeness; hash chain verify; PHI denylist scan.
10. **Source/threshold:** versioning, floors, auto-commit gating by eval, key rotation.
11. **Storage:** upload path/org scoping, signed URL expiry (time-travel), blocked-consent document access denied.

## 5. E2E scenarios (Playwright)
1. Login for each role lands on its home; forbidden routes redirect.
2. IE creates source, copies key, uploads synthetic summary → watches live status → record detail shows citations.
3. Source enabled (seeded as passed) with high-confidence doc → `auto_committed`, AI-extracted tag and provenance visible.
4. Low-confidence doc → reviewer queue → claim → correct one field via keyboard only → approve → committed with reviewer name.
5. Expired consent doc → blocked banner, no document access.
6. Admin pauses source → new upload escalates (`source_not_enabled`).
7. Admin audit reconstruct for the committed record; export CSV.
8. Dashboard (GA): seeded metrics render with n labels.
9. Accessibility: axe scan on login, ingest, records, record detail, review workspace, sources, dashboard, audit (0 serious/critical).
10. Responsive: non-review pages at 375 px without horizontal page scroll.

## 6. AI evaluation gates
As specified in spec 12 §4; runs in CI with replay and manually for held-out before release.

## 7. Performance and reliability
- 100 records queued at once, mocked vendors with realistic latency (OCR 4 s, LLM 20 s): all processed; p95 end-to-end < 2 min; no job stuck > 10 min; DB connections stable.
- Ingestion API: 60 req/s burst for 1 min with 5 MB files: p95 < 2 s accept time, no 5xx.
- Soak: 1,000 synthetic records, failure rate < 1%.

## 8. Security tests (detailed in Stage 7; baseline now)
IDOR on record/task/source ids; upload type spoofing and zip/PDF bombs (page and size limits); prompt injection corpus; secrets not in client bundle (`grep` build output for `SUPABASE_SERVICE_ROLE_KEY`, API keys); rate limit enforcement; worker secret required; SSRF none (no URL fetch from user input).

## 9. Acceptance matrix (PRD → feature → tests)

| PRD item | Spec | Primary acceptance tests |
|---|---|---|
| FR1 / US-001 multi-format intake | 03, 04 | 03 §7.1–7.5; 04 §7.1,7.6; E2E 2 |
| FR2 / US-002 consent gate | 05 | 05 §9.1–9.6; integration 4; E2E 5 |
| FR3 / US-003 grounded extraction | 06 | 06 §12; eval grounding/injection |
| FR4 / US-004 standards mapping | 07 | 07 §10; eval mapping |
| FR5 schema & completeness validation | 07, 08 | 07 §10.1,10.3; routing truth table |
| FR6 / US-005 confidence scoring | 08 | 08 §8.1–8.2; calibration eval |
| FR7 / US-006 threshold routing | 02, 08 | 02 §8; 08 §8.3–8.7 |
| FR8 / US-007 review interface | 09 | 09 §10; E2E 4 |
| FR9 / US-008 audit + provenance | 10 | 10 §8; integration 9 |
| FR10 / US-009 calibration | 13 | 13 §6.2–6.3,6.6 |
| FR11 / US-010 per-source visibility | 13 | 13 §6.1,6.5; E2E 8 |
| US-011 lab reports [MVP1] | 06,07,12 | extraction/mapping evals on `lab_report` set meet same gates; fixtures added |
| US-012 HIPAA [ITER] | 05 | `HipaaAuthorizationService` passes same adversarial suite; residency/BAA checklist |
| North Star / cost per record | 13 | cost aggregation SQL test |
| Responsible AI (disclosure, oversight, recovery) | 14 | 14 §9 |
| Evaluation plan & launch gates | 12 | 12 §9; launch checklist below |

## 10. Launch checklist (maps PRD Launch Plan)
| Stage | Must be true |
|---|---|
| Measurement launch (1–2%) | all MVP acceptance tests pass; extraction F1 > 95%; every committed field grounded; 100% manual audit of committed records shows 0 downstream errors; consent adversarial 100% blocked; auto-commit stays at fixed threshold with holdback ≥ 10% |
| Beta (2–10%, 2–3 real providers) | STP > 50%; F1 > 97%; mapping > 95%; escalation precision > 70%; downstream error < 0.5% for 2 weeks; no consent violations; per-source eval passed before enabling |
| GA | STP at target (> 80%); accuracy ≥ 99% on auto-commits (lower-bound rule); ECE < 5%; downstream error 0%; DPDP/ABDM compliance + security review passed; rollback drill executed |
