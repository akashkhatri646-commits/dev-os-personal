# Spec 14 — Safety Controls: Pause, Downstream Errors, Holdback, Rollback, Responsible-AI Disclosures [MVP core; GA automation]

> **Implementation status (Feature 13).** Built: `safety/{incidentService,breaker,budget,banners}.ts`, `fhir/supersede.ts`, `prompts/rollback.ts`, migration `0007_safety_controls.sql`, `POST /api/records/:id/error-report`, `GET /api/downstream-errors`, `PATCH /api/downstream-errors/:id`, `POST /api/admin/records/bulk-review`, `POST /api/admin/sources/pause-all`, `POST /api/admin/prompts/:component/rollback`, the `defer` stage outcome, the `/incidents` page, "Report an error" on the record page, "Pause all sources", and page-top banners. Differences from the text above: the kill switch treats anything other than the word `true` as off; the circuit breaker counts failures as audit events `worker.upstream_failure` (OCR, extraction and mapping stages only) and opens after five in a row within two minutes, for five minutes; a downstream-error review task opens the record page instead of a read-only review workspace; incidents are listed for admins only; prompt rollback has no UI. Not built: dashboard and fairness views (spec 13), the runbooks (Stage 6).

## 1. Goal
Guarantee the system fails closed, a bad source can be stopped in one click, confirmed downstream errors halt auto-commit, and every AI-originated value is disclosed as such.

## 2. Controls overview
| Control | Trigger | Effect | Release |
|---|---|---|---|
| Source pause | admin action; auto on downstream error / holdback alert | `auto_commit_enabled=false`, `pause_reason`; all new records → review | MVP |
| Manual-only mode | default state for new/unevaluated sources | same as paused but not an incident | MVP |
| Downstream error report | admin/reviewer report | creates `downstream_errors`, auto-pauses source, creates `downstream_error_review` task for the record and mandatory pipeline review | MVP |
| Shadow-review holdback | random % of would-be auto-commits | extra human review sample → true error rate | MVP (basic), GA (metrics) |
| Prompt/model rollback | regression or incident | re-activate previous prompt version; env model id revert | MVP (CLI/API) |
| Global kill switch | `SYSTEM_AUTOCOMMIT_ENABLED=false` (env, redeploy to change; runtime table is optional migration `0011`) | routing treats every source as not enabled | MVP |
| Spend cap | `LLM_DAILY_BUDGET_USD` | delay jobs, alert | MVP |
| Circuit breaker | ≥ 5 consecutive LLM/OCR failures in 2 min | pause claiming of extract/map jobs for 5 min, banner | MVP |

`SYSTEM_AUTOCOMMIT_ENABLED` is documented in `.env.example`; staging and deploy previews must set it to `false`. If unset or unparsable, the code treats it as `false` (fail closed).

## 3. Source pause / resume (spec 02 APIs)
- Pause: admin, reason ≥ 5 chars. Effects in one transaction: update source, insert audit `source.paused`, notify via `ALERT_WEBHOOK_URL`. In-flight records already past routing: their `commit` job re-checks source state (spec 10 §2) and aborts to `needs_review (source_paused)`.
- Resume: admin, note, requires `eval_status='passed'` **and** no open `downstream_errors` for the source with status ≠ `resolved`. Else 409 `OPEN_INCIDENT` / `EVAL_NOT_PASSED`.
- UI banner on source pages: "Auto-commit paused — <reason>" with link to incident.

## 4. Downstream error flow (US-008 backstop metric)
`POST /api/records/:id/error-report` (admin, reviewer): `{fhir_resource_id?, description 10..1000, severity: low|medium|high|critical}`.
1. Insert `downstream_errors` (status `open`); audit `error.reported` (ids + severity).
2. Auto-pause source (`source_paused=true`) for severity ≥ `medium`; for `low`, only create the task and flag.
3. Create `review_tasks(kind='downstream_error_review', priority=max)`; the workspace opens the record read-only with the committed resource, original draft, trace and diff, and a form for root cause (`extraction|mapping|ocr|threshold|consent|other` + note).
4. Admin closes the incident (`PATCH /api/downstream-errors/:id {status, root_cause, note}`); resume only after `resolved`.
5. Metrics: downstream error count feeds dashboard; any value > 0 is highlighted.
6. Corrected data: the erroneous FHIR resource is **marked superseded**, not deleted: set `resource.meta.tag += {system:'urn:health-ingest:status', code:'entered-in-error'}` and `status='entered-in-error'` where the resource type supports it (updates via admin service function that relies on the `fhir_resources` versioning trigger), and the corrected resource is committed via a reviewer-completed new review. Notify affected providers per `docs/runbooks/incident.md` (created in Stage 6).

## 5. Holdback sampling
Spec 08 §3 rolls the sample; spec 09 hosts the task; spec 13 computes error rate. Controls: `holdback_pct` min 5 when auto-commit enabled (spec 02), default 10, editable only by IE/admin with reason; changes audited as `source.updated`.

## 6. Rollback procedure (documented + implemented)
1. Admin pauses affected sources (bulk action in `/sources`: "Pause all sources").
2. `POST /api/admin/prompts/:component/rollback` (spec 12) and/or revert `LLM_MODEL_*` env var and redeploy.
3. Query affected records via `GET /api/audit?event=record.committed&from=<window>` + prompt_set filter → list of auto-committed records in the window → create `holdback_audit`-like tasks for each (`POST /api/admin/records/bulk-review {record_ids}` creates review tasks of kind `downstream_error_review`).
4. Re-run eval; resume sources per §3.

## 7. Responsible-AI product disclosures (UI/data requirements)
- Every committed value shows `AiExtractedTag`, source document link (role permitting), extraction method, consent reference, confidence; human-reviewed values show reviewer name and timestamp.
- FHIR `meta.tag` `ai-extracted` on all resources (spec 07); Provenance resource includes agent device and model id.
- Dashboard and reports show per-source breakdowns with sample sizes; **no single blended accuracy number** is displayed without the per-source table adjacent.
- Escalate-by-default segments: sources with < 50 labeled records, `flagged_poor`, handwriting-heavy or non-English documents (spec 04) — enforced via `auto_commit_enabled=false` and OCR rules.
- Limitations notice (static text in `/records/[id]` help drawer): "Ingestion aid, not a clinical decision system; values are AI-extracted and must not be treated as clinically verified."
- Fairness monitoring: segment views in dashboard (spec 13) + monthly audit checklist stored in `docs/runbooks/fairness-audit.md` (Stage 6).

## 8. Edge cases
- Pause during an active review: tasks continue; commits in `human` mode still allowed (human-approved), because pausing only removes automation.
- Auto-pause triggered twice: idempotent; keeps the first `pause_reason` and appends the later reason to audit only.
- Reporting an error on a record from a different org → 404.
- Severity downgrade after pause: admin may resume only via §3 rules.
- Kill switch toggled mid-batch: routing reads the setting per record; commit stage re-checks.
- Circuit breaker open: queued jobs stay queued (not failed, attempts not incremented); banner "Processing delayed (upstream provider issue)".

## 9. Acceptance criteria
1. Reporting a `high` downstream error pauses the source immediately; the next record from that source is escalated with reason `source_not_enabled`.
2. Resume is blocked while an incident is open (409).
3. With the kill switch off, no record auto-commits across any source (integration test).
4. Rollback of a prompt version restores the previous active version and the next record uses it (`prompt_set` shows the version).
5. Every committed resource exposes AI-extracted tag, consent ref and confidence in UI and FHIR.
6. Circuit breaker opens after 5 consecutive vendor failures, jobs are delayed not failed, and closes after 5 minutes of success probing.
7. Bulk review creation for a time window creates exactly one open task per affected record.
