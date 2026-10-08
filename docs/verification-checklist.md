# Verification checklist (deferred live checks)

Everything below has passed automated checks (typecheck, lint, unit tests, production build) but has **not** been exercised end to end against the real Supabase project in a browser session, unless marked **Verified live**. Run this list after all 14 features are built. Update it as features land.

## One-time setup status
| Item | Status |
|---|---|
| Migration `0001_baseline.sql` (full schema) | Done by user |
| Migration `0002_source_functions.sql` (atomic source/threshold/key functions) | Confirm run |
| Migration `0003_audit_functions.sql` (per-row audit check) | Confirm run |
| Public sign-up disabled in Supabase Auth | Done by user |
| First admin created and signs in | **Verified live** (lands on `/audit`) |
| Auth redirect URLs (`http://localhost:3000/auth/callback`) | Done by user |
| `.env.local`: Supabase keys, `SOURCE_KEY_PEPPER`, `PATIENT_ID_HMAC_KEY`, `PATIENT_ID_ENC_KEY`, `WORKER_SECRET`, `APP_BASE_URL`, `SYSTEM_AUTOCOMMIT_ENABLED=false` | Done by user |

## Verified live so far
- Sign-in as admin works.
- `POST /api/worker/tick`: wrong or missing secret returns 401; correct secret returns 200 and `claim_jobs` runs (0 jobs).
- `POST /api/internal/audit/verify`: returns 1 organisation, chain intact.
- Unauthenticated calls to `/api/ingestions`, `/api/sources`, `/api/audit/*` return 401; an invalid source key returns 401.

## To verify by hand (browser, signed in)
### Auth and users (Feature 2)
- [ ] Five wrong passwords lock the account; the correct password is still refused until the lock expires (15 min).
- [ ] Demoting or deactivating the only admin is blocked (`LAST_ADMIN`).
- [ ] Create a second user in the Supabase dashboard + a `profiles` row (see below); role guards differ (reviewer redirected away from `/audit`, `/sources`).
- [ ] "Email me a sign-in link" works for an existing user and is silent for an unknown address.
- [ ] **Known bug:** inviting a user from `/admin/users` sends an email whose link returns a token in the URL fragment; `/auth/callback` only handles `?code=`. Fix needed (add `/auth/confirm` with `verifyOtp` + email-template change) or create users via the dashboard.

Extra user SQL:
```sql
insert into public.profiles (id, org_id, email, full_name, role)
select '<AUTH_USER_UUID>', (select id from public.organizations limit 1), lower('<EMAIL>'), 'Test Reviewer', 'reviewer';
```

### Sources and thresholds (Feature 3)
- [ ] Create a source; copy the API key (shown once); rotate it; the old key stops working.
- [ ] New source has default thresholds 0.97 / 0.99 and auto-commit off.
- [ ] Change a threshold: new version, reason required; MedicationRequest below 0.95 refused.
- [ ] Enable auto-commit is blocked (no passed evaluation); pause/resume flows need the evaluation to pass first (Feature 8).
- [ ] Threshold matrix (`/settings/thresholds`) matches the per-source tab.

### Audit (Feature 4)
- [ ] Each action above appears in `/audit` with a verified hash; filters work (record, source, event, dates).
- [ ] Patient-identifier search works once records exist (identifier is sent in the request body, never the URL).
- [ ] Export CSV and JSON; the export appears as `audit.exported`.
- [ ] Tamper test: change one `audit_log.payload` as the database owner, then "Verify integrity" flags that entry; revert is **not** possible (append-only trigger), so do this on a throwaway project.

### Ingestion, queue and worker (Feature 5)
- [ ] Upload a PDF, a PNG, a `.txt` note and a pasted HL7v2 message from `/ingest` for a source; each becomes a record in status `received`.
- [ ] Uploading the same file twice returns the original record (no second record).
- [ ] An `.exe` renamed to `.pdf` is refused; a file over 25 MB is refused.
- [ ] HL7v2 batch (FHS/BHS wrapper with two messages) creates two records.
- [ ] Records stay at `received`/`consent_check` until Feature 6 deploys the consent stage (jobs are released, not failed).
- [ ] Realtime: status changes appear without reload; blocking the websocket falls back to 10-second polling.
- [ ] Retry button appears only for failed / retryable records.
- [ ] `/api/ingestions/[id]/document` returns a signed URL that expires; each access is audited.
- [ ] **Netlify limit:** synchronous functions accept request bodies up to about 6 MB, below the 25 MB product limit. Large scans need a direct-to-storage signed upload (not built). Decide before go-live.
- [ ] Not browser-verified: the `/ingest` upload interactions (file list states, drag and drop, per-file errors). Covered only by unit tests and typecheck.

### Consent gate (Feature 6)
- [ ] Add a consent for a test patient at `/admin/consent` (stub mode) using each scenario: Valid, Expired, Starts tomorrow, Revoked.
- [ ] Submit a record for a patient WITH valid consent: status moves received -> consent_check, then waits at normalisation (that stage ships in Feature 7).
- [ ] Submit records for patients with NO consent, an expired, a revoked and an out-of-scope consent: each ends `blocked_consent` with the matching reason, the document cannot be opened (403), and an alert is sent if `ALERT_WEBHOOK_URL` is set.
- [ ] A consent covering only one of two requested categories blocks (no stitching across artifacts).
- [ ] Revoke a consent in the admin console, then submit a NEW document: blocked. (Previously processed records are unaffected by design.)
- [ ] Set `CONSENT_MODE=abdm`: `/admin/consent` returns 404, the sidebar entry disappears, and new records end `failed` with "consent service unavailable" (the ABDM client ships in MVP 1; it must never fall back to the stub).
- [ ] Resubmitting the same document after fixing consent creates a new record (a blocked record does not count as a duplicate).
- [ ] Clock source: consent validity is evaluated with the application server clock (spec 05 asked for the database clock). Confirm server time is NTP-synced on Netlify; switch to a database `now()` function if skew is a concern.
- [ ] Not browser-verified: the `/admin/consent` page and the Add consent dialog (unit tests and typecheck only).

### Normalisation and OCR (Feature 7, digital-text part)
- [ ] After a record passes consent, a text note, an HL7v2 message and a PDF with a selectable text layer each reach `extracting` (the next stage ships in Feature 8) with `documents.normalized_text` filled and `ocr_engine` = `text` / `hl7-parser` / `pdf-text`.
- [ ] A scanned PDF or an image ends `needs_review` with "Text recognition is not set up yet" (`ocr_unavailable`) while no OCR engine exists; the Retry button re-runs normalisation once one is configured.
- [ ] A corrupt PDF ends `needs_review` as `unreadable_document` (no Retry offered: it needs a new file).
- [ ] A non-English (e.g. Hindi) note ends `needs_review` as `language_unsupported`; an English note with a few Hindi words is not rejected.
- [ ] Digital text always passes the 80% floor; the floor, the 60% per-page minimum and the 15% handwriting limit only bite once an OCR engine reports lower confidence.
- [ ] Production bundle: `pdfjs-dist` and `franc-min` were verified to load in `next dev` and `next start` locally. Confirm the same on a Netlify deploy (externalised packages must be traced into the function bundle).
- [ ] **Still to build:** the Textract / Document AI adapter (needs a provider, region and credentials) and rasterising scanned pages to images for the extraction model's vision input. Until then `OCR_PROVIDER` must stay unset: setting it to `textract` or `documentai` makes scans escalate as `stage_error:normalize` because no adapter exists.

### Grounded extraction (Feature 8, offline part)
- [ ] With `LLM_PROVIDER` unset, a record that finishes normalisation ends `needs_review` as "The language model is not set up yet" (`llm_unavailable`); Retry re-runs extraction once a model is configured.
- [ ] Setting `LLM_PROVIDER` without its key (`OPENAI_API_KEY`, or the three Azure variables) makes records escalate as `stage_error:extract`; the job error names the missing variables (`LLM_NOT_CONFIGURED`).
- [ ] The adapter is built (see "OpenAI / Azure OpenAI adapter" below). First live run on **synthetic** documents only. Check, per document: every found field has a quote that really appears in the source, no value appears that the document does not state, an injected instruction is ignored, and unreadable values are "not found".
- [ ] Decide the OpenAI route: OpenAI direct (no in-region guarantee) versus Azure OpenAI in an India region (needed for real patient data under the residency requirement). Pick a vision-capable model with structured outputs and set `LLM_MODEL_EXTRACTION`.
- [ ] Set `LLM_PRICE_INPUT_PER_MTOK` / `LLM_PRICE_OUTPUT_PER_MTOK` from your provider's pricing page so per-record cost is tracked; set `LLM_DAILY_BUDGET_USD`. (The budget guard itself ships with the live adapter.)
- [ ] The first extraction run stores the built-in prompt `extraction-v1` in `prompt_versions` and activates it; confirm the row exists afterwards.
- [ ] Your `.env.local` may still contain the old unused Anthropic / Voyage variable names; they are ignored. Add `OPENAI_API_KEY` (or the Azure variables) and `EMBEDDINGS_MODEL` when ready.
- [ ] Evaluation harness, labeled datasets and the source onboarding eval: later in Feature 8.

### OpenAI / Azure OpenAI adapter
- [ ] Choose the route first. **OpenAI direct** has no in-region guarantee: use it only with synthetic documents. **Azure OpenAI in an India region** is what real patient data needs under the residency requirement. Create the resource and a deployment, then set `LLM_PROVIDER=azure_openai`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_API_VERSION`, and put the **deployment names** in `LLM_MODEL_EXTRACTION` / `LLM_MODEL_LIGHT`. For OpenAI direct: `LLM_PROVIDER=openai`, `OPENAI_API_KEY`, and model ids.
- [ ] Pick a model that supports **vision and structured outputs** (strict JSON schema). Models that only accept their default temperature are handled: the adapter retries once without it and remembers.
- [ ] Set `LLM_PRICE_INPUT_PER_MTOK` / `LLM_PRICE_OUTPUT_PER_MTOK` for the extraction model (from the provider's price page). Without them calls are not costed, the daily spend cap never fills, and `cost_usd` stays 0. Set `LLM_DAILY_BUDGET_USD`. Prices apply to the extraction model only; the mapping step uses `LLM_MODEL_LIGHT` when set, and its cost is not counted unless the two are the same model.
- [ ] **Run the connection check** as an admin, from the browser console while signed in: `fetch('/api/admin/llm/check', {method:'POST'}).then(r => r.json()).then(console.log)`. It sends synthetic text only and reports per model (and for embeddings) whether the key, model name and structured outputs work, with timing, tokens and cost. Fix every `problem` it names before sending a document. It is limited to 6 calls a minute.
- [ ] Submit one **synthetic** discharge summary (a text note) and follow it through: extraction, mapping, validation, scoring, routing. Check the extraction prompt `extraction-v1` and mapping prompt `mapping-v1` rows now exist in `prompt_versions`, `ingestion_records.cost_usd` is above 0, `select get_llm_spend()` rises, and the audit log has no document text.
- [ ] Failure behaviour with the real provider: a wrong key makes records escalate as `stage_error:extract` with the reason `LLM_CREDENTIALS` in the job error; a rate limit or outage retries once and then escalates as `llm_error`; five failures in two minutes open the circuit breaker (banner appears).
- [ ] **Embeddings (optional):** set `EMBEDDINGS_MODEL` (for example `text-embedding-3-small`; Azure: the deployment name). It must accept the `dimensions` parameter: the adapter asks for 1024 to match the `vector(1024)` columns. Terminology and `knowledge_docs` rows need embeddings filled in by a seeding step (not built); until then search falls back to word matching, and an embeddings outage also falls back instead of stalling mapping.
- [ ] **Netlify function time limits (decide before deploying):** a model call can take 20-60 seconds, but a Netlify function that answers a request is cut off after a short limit (10 s by default, at most 26 s). The worker tick runs as a normal API route, so a slow call could be killed mid-job (the job is recovered after 5 minutes and tried again, but this wastes calls and money). Options for Stage 6: run the worker as a Netlify Background Function (up to 15 minutes), lower `LLM_REQUEST_TIMEOUT_MS`, or run the worker on a small always-on host. Until then, test with the app running locally (`npm.cmd run dev`) and the tick called by hand.
- [ ] **Not built:** the budget guard counts spend after each call, so one in-flight call can overshoot the cap slightly; a per-source concurrency limit (`LLM_MAX_CONCURRENCY_PER_SOURCE` is read but not enforced); streaming; page-image input to the model (needs the scan reader).

### Mapping and FHIR validation (Feature 9, offline part)
- [ ] Run migration `nextjs-app/supabase/migrations/0004_mapped_resource_flags.sql` (adds `mapped_resources.flags`). Mapping fails to save resources until it is applied.
- [ ] `terminology_concepts` is empty until seeded, so every code is "uncoded" and flagged; records then go to review at routing. Seed SNOMED CT / LOINC / ICD-10 subsets under their licences (India is a SNOMED CT member country; LOINC and ICD-10 are free to use). Confirm the display text and `resource_types` per concept.
- [ ] **Dev sample:** `nextjs-app/supabase/seed/terminology-sample.sql` loads about 55 concepts (diagnoses, common drugs and allergens, procedures, lab tests, ICD-10 codes) with synonyms and Indian brand names, plus abbreviation and brand-name expansions in `knowledge_docs`. It was written from memory for testing: check the codes against the official releases before relying on it, and load the real releases for production. Safe to run again.
- [ ] With concepts seeded but `LLM_PROVIDER` unset, a record ends `needs_review` as "mapping_unavailable"; Retry resumes at the mapping step, not extraction.
- [ ] Lexical search is used until an embeddings client exists (`getEmbeddingsClient()` returns null). Once `EMBEDDINGS_MODEL` is wired, re-check candidate quality on real terms (brand names, abbreviations) and the `search_terminology` RPC.
- [ ] `knowledge_docs` (kinds `drug_brand_map`, `abbreviation`): title = short form, content = what it means. Load a starter set and confirm "Crocin" is searched as paracetamol.
- [ ] On the first live run, check per resource: every code is one of the offered candidates, no wrong-concept matches (a broader or different drug is not accepted), dose ranges and unknown units are flagged, `in_hospital` medications are not built, and the encounter fails validation when the document does not state inpatient/outpatient.
- [ ] The first mapping run stores prompt `mapping-v1` in `prompt_versions`; confirm the row.
- [ ] Validation is the built-in structural validator (`FHIR_VALIDATOR_MODE=node`). `service` mode (HL7 validator with ABDM profiles) is not shipped; setting it makes the validate step fail. Plan the ABDM profile validation step before real commits.

### Scoring, routing and commit (Feature 10)
- [ ] Run migration `nextjs-app/supabase/migrations/0005_mapped_resource_source_ref.sql` (adds `mapped_resources.source_ref`). Scoring cannot find a resource's fields until it is applied. (Planned later migrations moved to 0006-0009.)
- [ ] Send one synthetic record all the way through with a source whose auto-commit is on. Check `field_scores` (field, resource, record rows), `routing_decisions` (thresholds, reasons, trace, `_checksum` key inside `thresholds_applied`), then `fhir_resources`, `provenance` and exactly one `record.committed` audit event.
- [ ] Source with auto-commit off: record ends `needs_review` with reason `source_not_enabled` and one open review task. Turn the global switch `SYSTEM_AUTOCOMMIT_ENABLED=false` and confirm the same.
- [ ] Holdback: with `holdback_pct` above 0, a clear record is sometimes escalated as `holdback` with a task of kind `holdback_audit` and `ingestion_records.holdback = true`.
- [ ] Pause a source between routing and commit: the record goes to review as `source_paused` and nothing is committed.
- [ ] Commit twice (re-queue the commit job): no duplicate `fhir_resources`; the second run finishes quietly.
- [ ] Consent re-check at commit: set `consent_checks.checked_at` to more than 24 hours ago, then (a) leave consent valid and confirm commit; (b) revoke it in the ledger and confirm the record becomes `blocked_consent` with an alert.
- [ ] Edit `routing_decisions.thresholds_applied` by hand for a routed record and confirm commit refuses it (`stage_error:commit`).
- [ ] **Not built:** the optional model self-assessment of scores (downward-only adjustments), the routing narrative, calibrated scores (identity mapping for now) and shadow evaluation of proposed thresholds. Scores are fully deterministic today.
- [ ] Thresholds below 0.90 let a record with a 0.70-capped value through the score test alone; routing escalates those records anyway through the `ambiguous_label` and `uncoded` reasons. Confirm in the first live run that no record with a dose range, unmapped unit or uncoded term auto-commits.

### Review queue and workspace (Feature 11)
- [ ] Run migration `nextjs-app/supabase/migrations/0006_review_functions.sql` (`submit_review`, `reject_review`, `release_expired_review_locks`). Approving, rejecting and the lock sweep need it. (Planned later migrations are now 0007-0010.)
- [ ] Sign in as a reviewer. Escalate a record (source with auto-commit off is the easy way). It should appear in `/review`; open it (this claims it, asks the consent ledger again, and moves the record to `in_review`).
- [ ] With two browsers (two reviewers): the second claim gets "another reviewer is working on this task"; a fourth open claim by one reviewer is refused (limit 3).
- [ ] Leave a claimed task untouched past `REVIEW_LOCK_MINUTES`: the next worker tick reopens it and the record returns to `needs_review`; the first reviewer's submit then shows the "hold ran out" banner and their decisions are kept.
- [ ] Correct one field and approve: exactly that field differs from `accept` in `review_corrections`, one row exists per field, the task is `completed`, the record is `committed`, `fhir_resources` and `provenance` (`ai_extracted_human_reviewed`, your user id) exist, and the audit log has `review.claimed`, `review.submitted`, `record.committed`.
- [ ] Correct a value so FHIR validation fails (for example clear the encounter class): the screen shows the issue and nothing is committed.
- [ ] Choose a code that is not in `terminology_concepts`: refused. Choose one outside the model's candidates that exists: accepted and stored with `reviewer_code_override`. (Needs the terminology table seeded.)
- [ ] Revoke the patient's consent in the stub ledger while a task is claimed, then claim or submit: the record becomes `blocked_consent`, its extracted data and stored file are purged (`record.phi_purged` audit event), and the task closes.
- [ ] Audit samples: as a reviewer, a `holdback_audit` task looks like any escalation (no "audit sample" badge or reason); as an admin it is labelled.
- [ ] Reject a record: every field is stored as `reject`, status `rejected` with reason `reviewer_rejected`.
- [ ] Ask for a new copy on a `low_ocr_quality` record: it closes as `rejected` (`reupload_requested`).
- [ ] Keyboard only: J/K move between fields, A / C / R decide, Enter saves a correction, Esc cancels, `[` `]` turn pages. Check with a screen reader that decisions are announced.
- [ ] Layout at 1280 px (three panes) and at tablet/phone width (tabs). Not checked in a browser yet: this feature was verified by tests and a production build only.
- [ ] **Not built:** page images with a drawn box (the source pane shows recognised text with the cited quote highlighted; the original file opens in a new tab), "use selected text as citation" for corrections, the "approve only after the source loaded" rule (no images yet), virtual scrolling for very large records, and per-reviewer review-time metrics (the time is derivable from `claimed_at` and `completed_at`).

### Record page, audit reconstruction and FHIR read (Feature 12)
- [ ] No new migration. Needs the earlier ones (0004-0006) applied.
- [ ] `/records` lists records with the status filter; `/records/[id]` shows the summary, the pipeline steps, and the Fields, FHIR, Decision, Consent, Provenance and Source tabs. Open a committed, an escalated, a rejected and a blocked-consent record: each step shows the right state (done, waiting, not run, blocked) with a text label.
- [ ] A committed record's FHIR tab shows committed resources (version, "AI-extracted"); an escalated record's shows drafts. Provenance shows the method (automatic or reviewed), model, prompt version ids, consent reference and reviewer.
- [ ] Source tab: "Open the original" opens a link that expires in minutes, and an audit `document.accessed` row appears. For a `blocked_consent` record the tab refuses to show the document.
- [ ] As an admin, "Why this outcome" (record page) and "Reconstruct this record" (audit entry drawer) show consent, scan quality, extraction counts, mapping, validation, scores against thresholds, routing reasons and trace, review decisions with the diff, and the commit, plus the audit chain with a verified/failed mark per entry. Check it for both a committed and an escalated-then-reviewed record. The read adds one `audit.reconstructed` audit row.
- [ ] Tamper with one audit payload as a database superuser: the affected entry shows "Verification failed" and the banner names its number.
- [ ] FHIR API (signed in as an admin or integration engineer, in the browser or with the session cookie): `GET /api/fhir/MedicationRequest/<id>` returns FHIR JSON (`application/fhir+json`) with `meta.versionId`, `lastUpdated` and the `ai-extracted` tag; `?_include=Provenance` returns a bundle with the resource and its Provenance (agent, source document, consent policy, confidence); `GET /api/fhir/Provenance/<id>` returns the Provenance; `GET /api/fhir/MedicationRequest?patient=<uuid>&_count=5&_page=1` returns a search-set bundle; any other parameter is a 422; a viewer gets 403; another organisation's resource is a 404.
- [ ] Layout checks at phone, tablet and desktop widths were not done in a browser: this feature was verified by tests and a production build only.
- [ ] **Not built:** live updates of the record page through Realtime (it polls every 5 seconds while a record is processing), and the `Patient` resource (the API serves the seven built resource types only).

### Safety controls (Feature 13)
- [ ] Run migration `nextjs-app/supabase/migrations/0007_safety_controls.sql` (incident close-out columns, `llm_spend_daily`, `add_llm_spend`, `get_llm_spend`). Reporting is fine without it, but resolving an incident and the spend cap need it. (Planned later migrations are now 0008-0011.)
- [ ] Report a **high** error from a committed record (button on the record page, reviewer or admin): the source is paused at once, the reported resource is marked `entered-in-error` (check its FHIR JSON: tag and status; the previous version is kept in `fhir_resource_versions`), an open `downstream_error_review` task appears in the review queue as "Downstream error", an alert is sent, and audit shows `error.reported` and `source.paused`. Send the source's next record: it is escalated as `source_not_enabled`.
- [ ] Report a **low** error: no pause, resource unchanged, a review task only. **Medium**: pause without an alert.
- [ ] `/incidents` (admin): the incident is listed; resolving needs a root cause, closes the review task, and writes `error.updated`. Resuming the source while the incident is open is refused (`OPEN_INCIDENT`); after resolving it works (the source's evaluation must also have passed).
- [ ] "Pause all sources" on `/sources` pauses every source that has auto-commit on, writes `source.paused` for each plus `source.paused_all`, and alerts once.
- [ ] Kill switch: set `SYSTEM_AUTOCOMMIT_ENABLED` to anything but `true` (or leave it unset): a banner says auto-commit is off and no record auto-commits for any source. Check that a typo such as `yes` also means off.
- [ ] Banners: paused sources (admin and integration engineer), open incidents (admin), "Processing delayed" and the spend-cap warning appear at the top of every page and disappear when the condition clears.
- [ ] Circuit breaker: with a provider adapter that fails (it throws a retryable upstream error), five failures within two minutes hold back OCR, extraction and mapping jobs for about five minutes (jobs stay queued, attempts not used, banner shown); consent, scoring, routing and commit keep running. One success closes it. Testable now with a wrong endpoint or key (OCR adapter still missing).
- [ ] Spend cap: set `LLM_DAILY_BUDGET_USD` low and run records through extraction. Once today's total (`select get_llm_spend()` in SQL) reaches it, extraction and mapping jobs wait (`released`, 15 minutes), one alert is sent, and the banner appears. Raising the cap resumes work. Needs `LLM_PRICE_*` set so calls have a cost.
- [ ] Prompt rollback: `POST /api/admin/prompts/extraction/rollback` (admin, empty body) re-activates the previous version; the next record's `prompt_set` shows it; `prompt.rolled_back` is audited. Refused when there is no earlier version.
- [ ] Bulk review: `POST /api/admin/records/bulk-review` with `{"record_ids": [...]}` creates exactly one open `downstream_error_review` task per record and reports `created` and `already_open`.
- [ ] Disclosures: every committed resource shows the "AI-extracted" tag in the FHIR and provenance tabs, and the record page has "About these values" with the limitations notice.
- [ ] **Not built:** the per-source dashboard and fairness views (spec 13), `docs/runbooks/incident.md` and `fairness-audit.md` (Stage 6), notifying affected providers (a runbook step), and a UI for prompt rollback (API only). A downstream-error review task opens the record page rather than a separate read-only review workspace.

### MVP acceptance tests (Feature 14)
- [ ] **Run `nextjs-app/tests/sql/acceptance.sql`** in the Supabase SQL Editor (all migrations applied first; run it while the worker is idle). It changes nothing: it ends with an error whose message is the report (`ACCEPTANCE RESULT: N passed, N failed, N skipped`). Send any `FAIL` lines back; they are real defects in a database function, constraint or policy. It was written without being run, so a failure may also be a mistake in the script. `SKIP` lines mean a precondition was missing (no profile to act as reviewer, or `auth.users` not writable from that role).
- [ ] After a build, run `npm run check:bundle`: it must report nothing found. Run it again against the deployed build once the real keys are set in the hosting environment.
- [ ] `npm test` passes (796 tests at the time of writing, including the four integration files that run the whole pipeline in memory).
- [ ] Read `docs/testing/acceptance-matrix.md`: the **Findings** list needs a decision (notably that "no known allergies" always goes to review), and the **Known gaps** list is the plan for Stage 5.
- [ ] **Not built:** Playwright end-to-end scenarios and axe scans, the AI evaluation harness and labeled sets, load and soak tests, and the fixtures that need an OCR adapter (scanned PDF, fax TIFF).

### Dashboard (partial, spec 13)
- [ ] `/dashboard` opens for every role (it is a viewer's only page): KPI tiles, then a per-source table, with a period of 7, 30 or 90 days. Check with a source that has a mix of auto-committed, reviewed and escalated records, and with a brand-new source (all "No data", no errors).
- [ ] Each rate shows the count behind it ("2 of 4") and "Small sample" under 30. The audit-sample error rate shows a 95% range. Open-incident and paused-source states show in text, not colour alone.
- [ ] The numbers match the database for one source over the period: settled records (committed, in review, rejected, failed; blocked-consent counted apart), straight-through = auto-committed and not an audit sample, queue depth = open or claimed tasks right now.
- [ ] Computed on every request (refreshes each minute): fine for the MVP, but with tens of thousands of records a day this should become the daily aggregation job in spec 13 (`source_metrics_daily`, migration 0009).
- [ ] **Not built:** accuracy against labeled data (shows "Not measured"), trend charts, segment filters, the north-star cost including reviewer time, automatic alerts, and calibration and threshold proposals.

## Environment and tooling
- [ ] `preview_start` launcher fails on this machine (Windows Python shortcut); dev server is started manually with `npm.cmd run dev` or Git Bash.
- [ ] Google Fonts may be unreachable in dev; the font falls back to the system font.
- [ ] `npm audit` reported advisories at install; review.
- [ ] Netlify: set `APP_BASE_URL`, `WORKER_SECRET` and all other env vars in the Netlify UI; confirm the scheduled functions `worker-tick` (every minute) and `audit-verify` (03:00 UTC) run.

## Security advisors (needs the project reachable by the Supabase connection)
- [ ] Run the Supabase security and performance advisors after all migrations.
- [ ] Test RLS directly: viewer reads zero rows from `fhir_resources`, `documents`, `ingestion_records`; cross-organisation reads return nothing.

## Deferred by design
- `POST /api/sources/:id/run-eval` and evaluation harness: Feature 8 (second part).
- Re-verifying consent at commit when more than 24 hours have passed: Feature 10.

## Admin re-run and system check
- [ ] As admin, open a record in "Needs review": a step picker and "Re-run from step" appear (not for other roles, not for finished records).
- [ ] Choose "Extract fields" → confirm → the record shows "Queued", then returns to review with freshly extracted fields; the Audit tab shows `record.rerun_requested`.
- [ ] A record a reviewer has claimed refuses the re-run ("A reviewer is working on this record").
- [ ] Open **System check** (admin sidebar): every item reads OK or an expected warning (OCR, embeddings, auto-commit off). Stop `worker:dev`, submit a record, wait 10 minutes: "Waiting jobs" turns Broken.
- [ ] "Test the model" shows the provider, model and latency per check.

## Security pass
- [ ] Run `supabase/rls-policies.sql` in the SQL Editor: its last three queries return no rows.
- [ ] System check shows migration `0008_rate_limit` as applied.
- [ ] Open the app and look at the response headers (browser dev tools → Network): `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`.
- [ ] Sign in with a wrong password 11 times within a minute: the 11th answer is "Too many requests" with a retry time.
- [ ] Sign out from the top bar: you land on the sign-in page and the Audit page shows `auth.logout`.
- [ ] The Supabase dashboard settings listed in `docs/security/security-plan.md` are done (sign-ups disabled first).
