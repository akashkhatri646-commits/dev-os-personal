# Spec 12 — AI Evaluation, Ground Truth, Prompt Library and Release Gates [MVP harness; GA benchmark]

## 1. Goal
Make "when the pipeline auto-commits without a human, is it right?" measurable on every change. Provide datasets, runners, targets, prompt/version management and a CI gate that blocks regressions.

## 2. Ground truth
| Origin (`eval_samples.origin`) | Content | Volume | Notes |
|---|---|---|---|
| `clinician` | De-identified Indian discharge summaries (scans, digital PDFs, a few HL7v2) labeled field-by-field by 2–3 reviewers | 150–200 (MVP target; **≥ 50 required before MVP eval sign-off**) | Majority vote per field; disagreement → `ambiguous=true` and `agreement` stored; ambiguous fields always escalate and are excluded from accuracy denominators but counted separately |
| `synthetic` | Generated from known FHIR bundles via a generator (`evals/generators/`), rendered to PDF/HL7/text with layout variants, injected noise (skew, blur), edge cases (missing dose, conflicting dates, ranges, NKDA, brand names, injection text) | ≥ 300 | Expected output exact by construction |
| `public` | n2c2/i2b2 discharge summaries (sanity check only; US context) | sample 50 | Not used for gates |
| `production_correction` | Reviewer corrections, anonymized, reviewed weekly by admin before inclusion | grows | Never auto-added |
Split: 70% `dev` / 30% `heldout`, assigned once at insertion, stratified by source/doc type; **tuning/prompt changes never touch `heldout`** except through the gate run. Dataset manifest in `evals/datasets/manifest.json` (ids, hashes, split, origin); files live in Storage (`EVAL_DATASET_BUCKET_PATH`), **no PHI or datasets in the git repo**.
Expected format (`eval_samples.expected`): `{ "fields": { "<field_key>": {"value": …, "span_quote": "…" | null} }, "codes": { "<field_key>": {"system","code"} }, "resources": [ … FHIR … ] }`.

## 3. Eval runners (`evals/runners/*.ts`, run via `npm run eval -- <kind> [--split dev|heldout] [--source <id>]`)
Runners execute the real pipeline stages in-process against sample documents with a test org (consent stubbed `valid`), using real vendor calls (cost-capped) or **recorded fixtures** (`--replay`) for CI.

| Runner | Metric | Definition |
|---|---|---|
| `extraction` | per-field precision/recall/F1; per resource type; field accuracy on would-be auto-commits | Match value after normalization (units, dates, case). F1 over `found` fields; `accuracy_auto = correct / total` over fields in records the router would auto-commit |
| `grounding` | `grounded_rate`, `fabrication_count` | % committed-eligible fields with valid span (target 100%); fields where value ∉ document (target 0) |
| `mapping` | exact-code match, top-3 recall, `invalid_code_rate` | against expected codes |
| `validation` | `pass_rate` for auto-commit candidates | 100% required |
| `calibration` | bucketed predicted vs actual accuracy; ECE | 10 buckets by aggregate score; ECE < 5% [GA gate] |
| `routing` | escalation precision (% escalated that needed a change), STP, false-auto-commit count | uses expected data as proxy for reviewer outcome |
| `consent` | adversarial suite: missing/expired/revoked/out-of-scope/stitching/malformed/timeout | 0 records processed without valid consent |
| `injection` | prompt-injection corpus (≥ 30 docs) | 0 altered fields |
| `source_onboarding` | per-source gate (spec 02) on ≥ 50 labeled records of that source | sets `provider_sources.eval_status` |
Each run inserts `eval_runs(kind, prompt_set, metrics, passed, sample_count)` and writes a markdown/JSON report to `evals/reports/<date>-<kind>.md` (reports contain metrics and sample ids only).

## 4. Targets and gates

| Metric | Target | Gate stage |
|---|---|---|
| Extraction field accuracy on would-be auto-commits | ≥ 99% | MVP release, MVP1, GA |
| Extraction F1 overall | ≥ 95% measurement launch; ≥ 97% beta; ≥ 97% GA | per launch table |
| Grounded rate | 100%; fabrication 0 | every run |
| Mapping exact match | > 95% | every release |
| FHIR validation pass for auto-commit candidates | 100% | every run |
| Consent adversarial | 0 violations | every run |
| Injection corpus | 0 altered fields | every run |
| Calibration error (ECE) | < 5% | GA; monthly after |
| Escalation precision | > 70% | beta/GA |
| Pipeline failure rate | < 1% | every run (mocked vendors + real sample) |
| p95 latency per record | < 2 min | perf test |

**CI gate** (`.github/workflows/eval.yml`): on PRs touching `src/server/prompts/**`, `src/server/pipeline/**`, `src/server/services/{llm,terminology,fhir}/**`, thresholds config, or model env defaults → run `npm run eval -- all --split dev --replay` and compare to `evals/baselines/main.json`; fail if any metric drops more than tolerance (F1 −1.0 pt, mapping −1.0 pt, any increase in fabrication/consent/injection violations = 0 tolerance). Held-out run is executed manually (`workflow_dispatch`) before a release tag and its result is stored as `eval_runs` and attached to the release.

## 5. Source onboarding eval
`POST /api/sources/:id/run-eval` → job `eval_source` executes: all `eval_samples` with that `source_id` (≥ 50), full pipeline, metrics for extraction F1 ≥ 0.97, grounded 100%, mapping ≥ 0.95, 0 validation failures among would-be auto-commits. Pass → `eval_status='passed'`, `eval_passed_at=now()`; fail → `failed` with report. Admin must still explicitly enable auto-commit (spec 02).

## 6. Prompt library
Table `prompt_versions` (schema). Files in `src/server/prompts/<component>/<version>.md` + `fewshot.json`, loaded by `scripts/seed-prompts.ts` into the table (`npm run seed:prompts`). Naming `extraction-v1`, `mapping-v1`, `scoring-v1`, `routing_explain-v1`.
Rules:
- Exactly one `active` per component (unique partial index).
- Activation API/command `POST /api/admin/prompts/:id/activate` (admin) requires a linked `eval_run_id` with `passed=true` on held-out; otherwise 409 `EVAL_REQUIRED`. Audit `prompt.activated`.
- Rollback `POST /api/admin/prompts/:component/rollback` re-activates the previously active version; audit `prompt.rolled_back`; admin can also pause sources.
- Every record stores `prompt_set` ids + `model_id` used.
- Prompt A/B: candidate version evaluated on `dev` first, then held-out; production rollout is global per component (no live traffic split in MVP); shadow mode compares candidate outputs on live records without committing [GA].
- Review trigger: job flags a field/source when reviewer correction rate > 5% over 30 days; recurring corrections generate few-shot candidates (manual approval).

Prompt text requirements are in specs 06 (extraction), 07 (mapping), 08 (scoring/routing narrative). Common rules: temperature 0; JSON via tool schema; untrusted-document delimiters; "not found over guess"; no chain-of-thought stored as authoritative.

## 7. Admin UI for evals/prompts [GA, minimal in MVP]
`/admin/evals`: latest runs per kind with metrics, pass/fail, trend; `/admin/prompts`: versions per component, active flag, linked eval run, activate/rollback with confirm. In MVP these may be CLI-only (`npm run eval`, `npm run prompts:activate`) with the API routes present.

## 8. Edge cases
- Vendor non-determinism: temperature 0, but run each held-out gate **twice**; require both to pass; metrics reported as mean with min/max.
- Cost control: `--max-usd` flag aborts runs exceeding budget; replay mode uses recorded vendor responses keyed by hash of request.
- Label ambiguity: ambiguous fields excluded from accuracy but required to escalate (`routing` runner asserts).
- Dataset leakage: unit test ensures no `heldout` sample id appears in few-shot examples or `dev` runs.
- Small sample sizes: runner reports 95% Wilson intervals; gate uses lower bound for the ≥ 99% accuracy claim once n ≥ 300 fields per resource type; below that, report "insufficient evidence" and the source cannot reach `passed`.
- Synthetic-only passes never set `eval_status='passed'` (requires `clinician` origin samples ≥ 50 for that source or approved equivalents).
- PHI handling: eval documents are de-identified before upload; storage path private; access admin only.

## 9. Acceptance criteria
1. `npm run eval -- extraction --split dev --replay` runs offline and outputs a report with per-field P/R/F1 and the matrix by resource type.
2. Introducing a prompt that fabricates a dose makes `grounding`/`extraction` runners fail the CI gate.
3. Consent and injection suites fail the build on any violation.
4. Activating a prompt without a passing held-out eval run is rejected (409).
5. Source `eval_status` becomes `passed` only when the §5 thresholds are met on ≥ 50 clinician-labeled records.
6. All eval reports contain no PHI (sample ids and aggregates only).
7. Baseline file `evals/baselines/main.json` is updated only by a PR that includes the eval report.
