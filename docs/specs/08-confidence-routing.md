# Spec 08 — Confidence Scoring and Threshold Routing [MVP fixed thresholds; GA calibrated] (Components 5–6, FR6–7, US-005–006)

> **Implementation status (Feature 10).** Built: `scoring/score.ts` (deterministic formula, caps, resource and record aggregates), `routing/decide.ts` (rule, holdback roll, priority, thresholds checksum), stages `score` and `route`. Differences: no LLM self-assessment, narrative or calibration yet; `field_scores` for a required field the document lacks is 0 and listed in the record row's `components.missing_required`; range/unit/timing/phase flags and uncoded terms escalate through `ambiguous_label` / `uncoded` as well as the 0.70 cap; the checksum of `thresholds_applied` is stored under the key `_checksum`; `escalate` outcomes carry a `taskKind` so audit samples become `holdback_audit` tasks.

## 1. Goal
Give every field and every record a calibrated-in-intent confidence score with a stored reasoning trace, then decide **auto-commit vs escalate** with a deterministic, fully logged rule.

## 2. Score components
For each field `f` (a field = one extracted attribute; one coded concept counts as the field's mapping):

| Component | Source | Range |
|---|---|---|
| `E` extraction_conf | model `confidence` after grounding (0 if not grounded) × OCR factor | 0–1 |
| `M` mapping_conf | `codings.match_confidence` for coded fields; `1.0` for non-coded fields (dates, numbers) | 0–1 |
| `V` validation_completeness | share of the resource's required elements present and valid for this field's resource: `valid_required / total_required`; 0 if resource validation `fail` | 0–1 |

OCR factor: `min(1, block_ocr_confidence / 0.95)` using mean confidence of the cited blocks (1.0 for HL7/text/pdf-text).

**Raw field score:** `s_f = w_e·E + w_m·M + w_v·V` with `w = {0.5, 0.3, 0.2}` (constants).

**Self-assessment (LLM, component `scoring`, MVP optional signal):** a second structured call returns per-field `{basis: 'stated'|'inferred', concerns[] (enum: 'ambiguous_text','abbreviation','multiple_candidates','table_layout','poor_ocr','conflict','range_value'), score_adjust: -0.2..0}`. Only **downward** adjustments are allowed (can never raise a score). Used only when the field has `basis=inferred` from extraction or `concerns`. In MVP this call is made once per record (all fields batched) with the light model `LLM_MODEL_LIGHT`; failure of this call is non-fatal (no adjustment, trace notes `self_assessment_unavailable`).

**Caps and overrides (deterministic, applied after the formula):**
| Condition | Effect |
|---|---|
| `found=false` for a required field | field score 0, escalate reason `ungrounded`/`missing_required` |
| `grounded=false` | score 0 |
| `basis=inferred` | `min(s_f, INFERRED_SCORE_CAP=0.80)` |
| cited-block OCR confidence < 0.80 | `min(s_f, LOW_OCR_SPAN_CAP=0.75)` |
| dose is a range, unit unmapped, `incomplete_timing`, `conflict`, `uncoded` | `min(s_f, 0.70)` (never auto-commits) |
| match_confidence ≤ 0.6 for coded field | `min(s_f, 0.70)` |

**Resource score:** `r = 0.7·min(s_f over required fields) + 0.3·mean(s_f over all fields)` where required fields = ★ attributes of the resource (spec 06 §3). **Record aggregate:** `min(r)` over all resources to be committed. Rounded to 3 decimals (`numeric(4,3)`).

All scores written to `field_scores` (`scope` = field/resource/record) with `components` JSON `{E, M, V, ocr_factor, caps_applied[], adjust, dropped_ungrounded?, duplicate_mentions?}` and a deterministic text `reasoning` built from templates (e.g. `"medication[0].dose_value: E=0.93 M=1.00 V=1.00 → 0.97; no caps"`). LLM prose is not used as the authoritative reasoning.

**Calibration [GA]:** after raw scoring, if an active calibrator exists for `(source_id, resource_type)` with ≥ 50 labeled samples, replace `r` by `calibrate(r)` (isotonic regression map stored in `calibrators` JSON in `threshold_proposals.evidence`/config table `calibrators`). MVP: identity mapping. The trace records `calibrated: false|true` and the mapping version.

## 3. Routing rule (`stages/route.ts`) — deterministic code, no LLM decision
```
inputs: record, consent check, documents.ocr_confidence, mapped_resources, extracted_fields,
        field_scores, thresholds (spec 02), source flags, holdback roll
reasons = []
if consent.result != 'valid'                           → (cannot reach here; assert)
if ocr_confidence < OCR_CONFIDENCE_FLOOR               → reasons += 'low_ocr'
if any mapped_resources.validation_status != 'pass'    → reasons += 'schema_invalid'
if any extracted_field(found && !grounded)             → reasons += 'ungrounded'
if any required field not found                        → reasons += 'ungrounded'  (missing required)
if any resource uncoded                                → reasons += 'uncoded'
for each resource r:  thr = getEffectiveThreshold(source, r.type)
      if score(r) < thr                                → reasons += 'below_threshold'
if !source.auto_commit_enabled                         → reasons += 'source_not_enabled'
if injection_suspected or conflict flags               → reasons += 'ambiguous_label'
if reasons is empty and holdbackRoll(source.holdback_pct) → reasons += 'holdback'; record.holdback=true
decision = reasons.isEmpty ? 'auto_commit' : 'escalate'
```
`holdbackRoll`: `crypto.randomInt(0, 10000) < holdback_pct*100`; roll happens **only** when everything else passes. Holdback records are escalated normally (they enter the queue as `kind='holdback_audit'` tasks flagged "audit sample") — reviewers see them like any other record but the UI hides the "would have auto-committed" flag from the reviewer to avoid bias; the flag is visible to admins/metrics.

Shadow evaluation [GA]: if the source has a pending `threshold_proposals` row, compute the decision at the proposed threshold too and store it under `thresholds_applied.shadow` without acting.

Thresholds applied are stored per resource: `{ "MedicationRequest": {threshold: 0.99, version: 1, score: 0.995, pass: true}, ... }`.

**Routing trace (stored in `routing_decisions.reasoning_trace`):** deterministic template `"Record aggregate 0.982. Resource MedicationRequest score 0.981 < threshold 0.990 (v1) → below_threshold. Validation: pass (6/6). Source auto-commit: enabled. Decision: escalate."` An optional LLM narration (component `routing_explain`, light model) may append a plain-language paragraph under a separate heading **"Narrative (informational, not authoritative)"**; failure to produce it never blocks routing.

## 4. Outcomes
- `auto_commit`: write `routing_decisions` (decision `auto_commit`), audit `routing.decided`, enqueue `commit` job (stage `commit` calls `commit_record(record, 'auto')`; on SQL exception → record `needs_review` `stage_error:commit` + audit and alert).
- `escalate`: write decision, create `review_tasks` (spec 09 §2 priority), status `needs_review`, audit `routing.decided` with reason list.

## 5. APIs
No dedicated public routes. Read access via `GET /api/ingestions/:id` (`decision`, `scores`, `thresholds_applied`) and `GET /api/ingestions/:id/trace`. Threshold management is in spec 02.

## 6. UI
- `ConfidenceBar`: horizontal bar 0–100% with numeric label; icon + text status (High ≥ threshold / Review below) so color is not the only cue.
- `RoutingSummaryCard`: aggregate score, per-resource score vs threshold table, reasons chips, rule version, "Narrative" collapsible.
- Reviewer sees per-field scores sorted ascending (lowest first), with `concerns` chips.

## 7. Edge cases
- Resource set empty (nothing extracted) → aggregate 0 → escalate (`ungrounded`).
- Mixed record: Condition 0.99, MedicationRequest 0.95 → whole record escalates (record-level routing in MVP); GA option "partial commit" is out of scope.
- Threshold missing → 1.0 (fail closed).
- Score exactly equals threshold → passes (`≥`).
- Source paused between scoring and routing: routing reads `auto_commit_enabled` at decision time inside the same transaction as the decision insert; commit job re-checks the source state and aborts to `needs_review` (`source_paused`) if disabled.
- Floating point: scores stored as `numeric(4,3)`; comparisons use rounded values.
- Self-assessment call times out: continue without adjustment (never blocks, never raises scores).
- Clock/idempotency: `routing_decisions.record_id` unique; re-run upserts the same decision; a record already `auto_committed` is never re-routed.

## 8. Acceptance criteria
1. Score computation unit tests cover the formula, each cap, and aggregation (min/mean blend) with exact expected values.
2. A `basis=inferred` field can never yield a field score > 0.80; a record containing one cannot auto-commit at thresholds ≥ 0.90.
3. Routing truth-table tests: each single reason independently forces escalation; auto-commit only when all clear.
4. `routing_decisions` row exists for 100% of routed records with thresholds, version, reasons, trace.
5. Holdback: with `holdback_pct=10`, ~10% (±3% over 2,000 simulated eligible records) are escalated with reason `holdback`.
6. Changing a threshold affects only records routed after the change; past decisions keep their stored `thresholds_applied`.
7. Source with `auto_commit_enabled=false` never auto-commits regardless of score.
