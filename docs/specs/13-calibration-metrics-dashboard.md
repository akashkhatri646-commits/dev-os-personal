# Spec 13 — Calibration Loop, Metrics and Per-Source Dashboard [GA] (FR10–11, US-009–010)

> **Implementation status (partial).** Built now: a live-computed dashboard at `/dashboard` (`metrics/compute.ts`, `metrics/dashboard.ts`, `GET /api/metrics/sources?days=7|30|90`, `DashboardView`): per-source records, straight-through rate, escalation precision, audit-sample error rate with a Wilson interval, review time, queue and its age, cost per record, downstream errors, with the sample size shown beside every rate. Not built: `source_metrics_daily` aggregation (migration 0009), trends, segments, accuracy against gold, the north-star cost, alerts, the calibration loop and threshold proposals (sections 1.2-3 above).

Build after MVP/MVP1 are live. MVP records already capture all raw data needed (`review_corrections`, `routing_decisions`, `field_scores`, `ingestion_records.cost_usd`, `review_tasks` timestamps).

## 1. Metrics definitions (per source, per day; stored in `source_metrics_daily`)

| Metric | Formula | Notes |
|---|---|---|
| `records` | records created that day with a terminal-or-routed status | excludes `blocked_consent` (reported separately) |
| STP rate | `stp_count / records` where `stp_count` = `auto_committed` records **not** holdback-sampled | holdback-sampled records excluded from STP numerator but counted in denominator |
| Escalation precision | `review_changed / escalated` where `review_changed` = escalated records whose review had ≥ 1 `correct` or `reject` | holdback audit tasks excluded |
| Holdback error rate | share of `holdback_audit` records where reviewer changed ≥ 1 field | **true error rate of the auto-commit path**; Wilson 95% CI |
| Mean review time | mean(`completed_at − claimed_at`) of completed tasks | seconds |
| Queue depth | `review_tasks` with status `open|claimed` | live, not daily |
| Accuracy vs gold | latest source onboarding / benchmark eval run `accuracy_auto` | from `eval_runs` |
| Cost per record | `sum(cost_usd)/records`; **North Star** = `sum(cost_usd + reviewer_minutes × REVIEWER_COST_PER_MIN) / records_successfully_ingested_at_≥99%_accuracy` | `REVIEWER_COST_PER_MIN` set in `.env` (add var in GA migration; default empty → cost shown LLM/OCR-only with banner) |
| Downstream errors | count of `downstream_errors` for source | target 0 |
| Segmented | all of the above by `segment` = `{size_class, region, language, doc_type}` | stored in jsonb and queried by dashboard filters |
| Time-to-trust | days from source `created_at` to first week where STP ≥ target and holdback error rate ≤ 1% | computed on demand |

Aggregation job `POST /api/internal/metrics/run` (secret-protected; Netlify scheduled hourly for today, nightly for yesterday finalize): upserts `source_metrics_daily` from base tables via SQL function `refresh_source_metrics(p_day date)` (migration `0009_metrics.sql`).

## 2. Alerts (`services/metrics/alerts.ts`, evaluated after each aggregation)
| Alert | Condition | Action |
|---|---|---|
| STP drift | weekly STP changes by > `ALERT_STP_DELTA_POINTS` (5) vs previous week (n ≥ 50 records) | webhook + dashboard card |
| Low escalation precision | < `ALERT_ESCALATION_PRECISION_MIN` (0.60) over 7 days (n ≥ 30 escalations) | webhook + card |
| Auto-commit correction rate | holdback error rate > `ALERT_CORRECTION_RATE_MAX` (0.01) over rolling 30 days (n ≥ 100 samples) | webhook + **auto-pause source** (spec 14) |
| Pipeline failure rate | `failed / records > 1%` daily | webhook |
| Audit chain broken | `verify_audit_chain` non-null | webhook, banner |
| Queue aging | oldest open task > 24 h | webhook + card |
| Cost spike | daily cost > 1.5 × trailing 7-day mean | webhook |
Alerts stored as audit events (`alert.raised`, payload ids/metrics only) and surfaced by `GET /api/metrics/summary`.

## 3. Calibration loop (US-009, FR10)
Purpose: raise STP by reducing needless escalations while keeping accuracy, learning from reviewer corrections. **Never changes thresholds automatically**; it produces proposals.

Weekly job `POST /api/internal/calibration/run` (secret; Netlify schedule Monday 02:00 UTC):
1. For each source with ≥ 50 reviewed/holdback records in the last 90 days, per `resource_type` with ≥ 30 samples:
   - Build `(aggregate_score, correct?)` pairs where `correct = no field in that resource was corrected/rejected`; sources: escalated reviews + holdback audits (holdback gives unbiased high-score samples).
   - Fit isotonic regression (pool adjacent violators) mapping raw score → empirical accuracy; compute ECE on a 20% holdout.
2. Find the smallest threshold `t` such that the calibrated accuracy of records with score ≥ t has Wilson 95% lower bound ≥ **0.99** (target) and sample count ≥ 100 above `t`.
3. If `t` differs from current by ≥ 0.005, insert `threshold_proposals(source_id, resource_type, current_value, proposed_value, evidence={n, ece, accuracy_lb, curve, expected_stp_delta})`. Proposed value never below the floors in spec 02 and never lower than current for MedicationRequest/AllergyIntolerance unless `n ≥ 300`.
4. Store the calibrator (monotone curve) in new table `calibrators(source_id, resource_type, version, curve jsonb, ece, n, active, created_at)` (migration `0009`), activated only when approved with the proposal.
5. Audit `calibration.proposed`.
Segment guard: before proposing, compare correction rates across segments (`size_class`, `language`); if the worst segment's error rate exceeds the overall by > 2× → proposal blocked with `evidence.blocked_reason='segment_skew'` and alert.

APIs:
| Method/Path | Roles | Behavior |
|---|---|---|
| `GET /api/calibration/proposals` | IE, admin | pending + recent proposals with evidence |
| `POST /api/calibration/proposals/:id/approve` | admin | creates new `routing_thresholds` version (reason = "calibration proposal <id>"), activates calibrator, status `approved`; audit `calibration.applied` + `threshold.changed` |
| `POST /api/calibration/proposals/:id/reject` | admin | `{note}`; status `rejected` |

Shadow mode: while a proposal is pending, routing logs the shadow decision at the proposed value (spec 08 §3) so the admin sees real counterfactual STP/errors on live traffic before approving.

## 4. Dashboard (`/dashboard`) — all roles (aggregates only, no PHI)
APIs: `GET /api/metrics/sources?from&to&size_class&language&doc_type` → rows per source; `GET /api/metrics/sources/:id/trend?metric&from&to`; `GET /api/metrics/summary` → north star, global STP, alerts.
UI (design-system tokens, chart rules per `dataviz` conventions):
- KPI tiles: North Star cost/record (with target line), STP, accuracy vs gold, escalation precision, mean review time, downstream errors (red if > 0).
- **Source table**: per source columns (STP, queue depth, accuracy, precision, review time, cost/record, auto-commit status, trend sparkline); sort; filters by segment; row click → source detail Activity tab.
- Charts: STP trend (line), escalation rate by source, calibration curve (predicted vs actual with ideal diagonal), cost per record trend, review time distribution.
- Alerts list with timestamps; "Updated at" label; empty state when n is too small ("Not enough records yet (n=…)"). Every rate shows sample size n; rates with n < 30 are greyed with "low sample".
- Export CSV of the table (aggregates only).

## 5. Edge cases
- Source with zero records: tiles show "—", not 0%.
- Small samples: show Wilson intervals; do not alert below minimum n.
- Day boundaries use UTC; dashboard displays UTC with label.
- Backfill: `refresh_source_metrics` idempotent (upsert) and callable for a date range via CLI.
- Reviewer cost unknown: cost per record excludes reviewer time and the tile says "LLM+OCR only".
- Gold accuracy missing: tile "No benchmark yet".
- Calibration proposed while a threshold edit is pending: proposal `current_value` mismatch at approval time → 409 `STALE_PROPOSAL`.
- Reviewer bias: report correction counts per reviewer in admin-only view; proposals blocked if one reviewer produced > 70% of corrections for the source (`evidence.blocked_reason='reviewer_skew'`).

## 6. Acceptance criteria
1. Dashboard values for a seeded dataset match hand-calculated STP, precision, holdback error rate, review time and cost per record (SQL test with fixtures).
2. Calibration job produces a proposal only with ≥ 100 samples above the proposed threshold and Wilson lower bound ≥ 0.99, and never applies it automatically.
3. Approving a proposal creates a new threshold version, activates the calibrator and logs audit events; stale proposals are rejected.
4. Alert fires when holdback error rate exceeds 1% (n ≥ 100) and the source is auto-paused.
5. Viewer role sees the dashboard with no PHI; direct queries to PHI tables fail.
6. After feeding 300 simulated corrections for a source, the proposed threshold reduces expected escalation rate while the evidence curve shows ECE < 5%.
