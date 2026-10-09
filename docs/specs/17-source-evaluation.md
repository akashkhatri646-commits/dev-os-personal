# Spec 17 — Source evaluation from reviewer decisions (plan, awaiting approval)

> **Implementation status (approved with the recommended decisions, built 2026-10-09).** Built: migration `0010_source_evaluation.sql`; `services/evaluation/{compute,load,evaluationService}.ts`; `GET /api/sources/:id/evaluation` and `POST /api/sources/:id/run-eval`; the Evaluation tab on a source; `Eval passed (synthetic|real)` badges; reset of a pass when thresholds change; refusal to enable or resume auto-commit when the pass covered a different model (`EVAL_STALE`). Decisions taken: a synthetic basis may pass and is always labelled; the default bar is kept; admin only; staleness resets. Accuracy lower bounds are one-sided 95% Wilson bounds, so 0.99 needs roughly 270 medication/allergy/lab fields with no mistakes. Not built: see §7.

Original plan below. It narrows spec 12 §5 to what can be built and trusted now.

## 1. Goal
Replace the manual database edit that marks a source "evaluation passed". Answer, with numbers: **when this source's records score above a threshold and nobody checks them, how often is the output right?** Turn that into (a) a per-source evaluation screen, (b) a recorded evaluation run, and (c) a gate on enabling auto-commit that the app itself enforces.

## 2. The answer key
Reviewers already provide it. Every approved or rejected review stores one row per field in `review_corrections`: `accept`, `correct` (with the corrected value or code) or `reject`. Accepted means the system was right; corrected or rejected means it was wrong. No dataset has to be uploaded or labelled separately.

Joined for each field: the model's confidence, whether the quote was found in the document, whether the value was stated or inferred, the field score, the resource's score and threshold, and the routing decision (including the random audit holdback).

Limits that must be shown, not hidden:
- Only reviewed records are labelled. Auto-committed records are not, except the holdback sample.
- A reviewer who accepts everything makes the numbers look better than they are. The screen shows the share of records accepted in full and the median time to decide, so a rubber-stamp pattern is visible.
- Synthetic documents measure the mechanics, not real-world accuracy. Every run records its basis (`synthetic` or `real`) and the badge on the source shows it.

## 3. What is measured (per source, over a chosen period)
| Metric | Definition |
|---|---|
| Reviewed records / fields | counts; also records with zero corrections |
| Field accuracy | accepted / (accepted + corrected + rejected), with a 95% Wilson interval |
| Accuracy by field and by resource type | same, grouped (dates, dose, code, phase, ...) |
| Code accuracy | for coded fields, code unchanged by the reviewer |
| Ungrounded values | fields whose quote was not found in the document (must be 0 among would-be commits) |
| Inferred values | share of fields marked inferred, and their accuracy |
| Calibration | fields bucketed by score (0.5-0.6 ... 0.9-1.0): predicted score versus actual accuracy |
| Would-be auto-commit accuracy at threshold T | among reviewed resources scoring at or above T, the share with no correction at all, with n and the lower bound |
| Suggested thresholds | the lowest T per resource type whose lower bound meets the target and n is sufficient; or "insufficient evidence" |
| Audit holdback accuracy | the same measure restricted to records randomly held back after auto-commit was on: the one unbiased sample of what auto-commit does |

## 4. The bar (configurable, defaults)
- At least **50 reviewed records** and **300 reviewed fields** for the source (spec 12 §5 and §8).
- Overall field accuracy lower bound **>= 0.99**; medication, allergy and lab fields have their own bar: **>= 0.99**; other fields **>= 0.97**.
- Code accuracy **>= 0.95**.
- **0 ungrounded values** among would-be commits.
- Below the minimums the result is **"insufficient evidence"**, never "passed" and never "failed".
Settings: `EVAL_MIN_RECORDS`, `EVAL_MIN_FIELDS`, `EVAL_TARGET_ACCURACY`, `EVAL_TARGET_ACCURACY_OTHER`, `EVAL_TARGET_CODE_ACCURACY`. Changing them is an admin action and is recorded.

## 5. What gets built
**Database (migration 0010):** nothing new for the computation (it reads existing tables). `eval_runs` already exists; add the column `basis text check (basis in ('synthetic','real'))` and allow audit events `source.eval_run` and `source.eval_passed`.

**Server**
- `evaluation/compute.ts`: pure function from reviewed rows to the metrics above, plus the verdict; fully unit-tested.
- `evaluation/evaluationService.ts`: loads reviewed rows for a source and period; `getEvaluation` (live view); `runEvaluation` (stores an `eval_runs` row with the metrics and verdict, sets `provider_sources.eval_status` to `passed` or `failed`, sets `eval_passed_at`, audits it).
- `GET /api/sources/:id/evaluation` (admin, integration engineer): live metrics.
- `POST /api/sources/:id/run-eval` (admin): stores the run and updates the status; `409 INSUFFICIENT_EVIDENCE` below the minimums.
- A passed status goes back to `none` when thresholds are lowered or the prompt or model changes (so an old pass cannot cover a new configuration). The run stores the prompt set and model it covered.

**Screens**
- Source detail gets an **Evaluation** tab: verdict banner (Passed / Not enough evidence / Does not meet the bar), the evidence counts against their minimums, accuracy tables by field and resource type, the calibration table, suggested thresholds, the rubber-stamp indicators, the basis badge, and the **Run evaluation** button with a confirmation.
- The Safety tab's **Enable auto-commit** button keeps requiring a passed evaluation, and now links to the Evaluation tab when it is not met.
- The source list shows the basis next to the evaluation badge ("Passed (synthetic)").

**Tests:** unit tests for every metric and edge case; integration tests through the fake database for run, pass, fail, insufficient evidence and staleness; an acceptance check in `tests/sql/acceptance.sql` that a direct database edit still cannot enable auto-commit without a passed status.

## 6. Edge cases
- A field the reviewer removed, a resource the reviewer deleted, or a resource added by the reviewer: counted as a miss for the field or resource and listed separately.
- A bulk "accept all": counted as accepted but flagged in the rubber-stamp indicator.
- Several reviews of the same field (rework): the latest decision counts.
- Records with a blocked consent or a failed pipeline have no corrections and are excluded.
- A source with no reviews: the tab explains how to produce evidence (review at least N records) instead of showing empty tables.
- Reviewer decisions made before this feature existed are included.

## 7. Not in this plan (later, from spec 12)
Uploaded labelled datasets and the synthetic generator; the offline runner and CI regression gate; replay fixtures; the consent adversarial and injection suites; prompt activation gated on an evaluation; reviewer-agreement scoring; fairness views.

## 8. Decisions needed from you
1. **Synthetic basis:** may a source with only synthetic reviewed records reach "Passed"? Recommended: yes for the pilot, marked "Passed (synthetic)" everywhere it appears, with real-data sources requiring `real` basis.
2. **The bar:** keep the defaults above (50 records, 300 fields, 0.99 / 0.97 lower bounds), or relax them for the demo? Relaxing weakens the meaning of "passed".
3. **Who can run it:** admin only (recommended).
4. **Staleness:** reset to "none" when thresholds, prompt or model change (recommended).

## 9. Acceptance criteria
1. The Evaluation tab shows correct counts and accuracy from reviewer decisions for a source with at least one reviewed record.
2. Below the minimums the verdict is "insufficient evidence" and `run-eval` answers 409.
3. At the minimums with accuracy below the bar the run is stored as `failed`; auto-commit still cannot be enabled.
4. At the minimums with accuracy at or above the bar the run is stored as `passed`, `eval_status` becomes `passed`, and the Enable auto-commit button works.
5. Lowering a threshold or activating a different prompt or model resets `passed` to `none`, with an audit entry.
6. Calibration and "accuracy at threshold" figures match a hand calculation on a small fixture.
7. No document text or patient identifier appears in the stored run or the screen; only field names, counts and rates.
