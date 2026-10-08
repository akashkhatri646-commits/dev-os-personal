# Spec 09 — Escalation Review Queue and Workspace [MVP; hardening MVP1] (Component 7, FR8, US-007)

> **Implementation status (Feature 11).** Built: `review/{reviewService,workspace,submitPlan,purge,locks}.ts`, migration `0006_review_functions.sql` (`submit_review`, `reject_review`, `release_expired_review_locks`), the seven `/api/review-tasks` routes plus `/api/terminology/search`, and the `/review` queue and `/review/[taskId]` workspace. Differences from the text above: the source pane shows recognised text with the cited quote highlighted (no page images yet); claim, submit and the worker sweep re-verify consent or expire locks as specified; a missing required value cannot be accepted as it is (supply it or reject the record); for reviewers an audit sample shows no reasons rather than a made-up one; `403` for an unclaimed task uses reasons `CLAIM_REQUIRED` / `CLAIMED_BY_OTHER`. Not built: page images with boxes, citation picking from selected text, virtualised lists, Playwright keyboard test (Stage 5).

## 1. Goal
Let a Data Ops reviewer resolve escalated records **field by field**: see the source, the draft, the citation, per-field confidence and the reasoning trace side by side, and accept / correct / reject each field. Every decision is stored as labeled calibration data.

## 2. Task creation and priority
Created by routing (or normalization/stage failures) via `createReviewTask(recordId, kind)`; unique open task per `(record_id, kind)` (partial unique index).
`priority = 100·risk_weight + 50·(1 − min_field_score) + age_hours`:
- `risk_weight`: 1.0 if record contains MedicationRequest/AllergyIntolerance/lab Observation; 0.5 otherwise; +0.5 if reason `low_ocr_quality`.
- Higher = earlier. `age_hours` recomputed at query time (sort expression), not stored; stored `priority` holds the static part.
Kinds: `escalation`, `holdback_audit` (random auto-commit sample), `downstream_error_review`.

## 3. Task lifecycle

| State | Entered by | Rules |
|---|---|---|
| `open` | creation / release / lock expiry | visible in queue |
| `claimed` | `claim` | `claimed_by`, `lock_expires_at = now + REVIEW_LOCK_MINUTES (30)`; one claim per task; reviewer may hold max 3 claimed tasks |
| `completed` | `submit` | corrections stored; record committed or rejected |
| `released` | `release` or expiry job | returns to `open` (new row not needed: status set back to `open`; record `released` event in audit) |

Lock expiry: handled lazily (`claim` treats expired locks as open) and by the worker tick (`UPDATE review_tasks SET status='open', claimed_by=null WHERE status='claimed' AND lock_expires_at < now()`; record status `in_review → needs_review`). Lock refresh: workspace calls `POST …/heartbeat` every 5 min while active (extends `lock_expires_at`).

## 4. API

| Method/Path | Roles | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/review-tasks` | reviewer, admin | `?status=open&kind&source_id&resource_type&mine=true&limit&cursor` | `{data:[{id, record_id, kind, priority, source_name, doc_type, reasons[], min_field_score, resource_types[], age_minutes, claimed_by_name?}]}` ordered by priority+age | |
| `POST /api/review-tasks/:id/claim` | reviewer | — | `200 {lock_expires_at}` | 409 `ALREADY_CLAIMED`, 409 `CLAIM_LIMIT`, 409 `CONSENT_NO_LONGER_VALID` (re-verifies consent) |
| `POST /api/review-tasks/:id/heartbeat` | lock owner | — | `{lock_expires_at}` | 409 `LOCK_LOST` |
| `POST /api/review-tasks/:id/release` | lock owner, admin | — | `200` | |
| `GET /api/review-tasks/:id` | lock owner, admin | — | workspace payload (§5) | 403 if claimed by someone else (non-admin); audit `document.accessed` |
| `POST /api/review-tasks/:id/submit` | lock owner | body §6 | `200 {status, fhir_resource_ids?}` | 409 `LOCK_LOST`; 409 `CONSENT_NO_LONGER_VALID`; 422 `DECISION_MISSING` / `INVALID_CODE` / `VALIDATION_FAILED` (with FHIR issues) |
| `POST /api/review-tasks/:id/request-reupload` | lock owner | `{note}` | `200` (record → `rejected`, reason `reupload_requested`) | only for `low_ocr_quality`, `unreadable_document`, `language_unsupported` |

## 5. Workspace payload (`GET /api/review-tasks/:id`)
```json
{
  "task": {"id","kind","lock_expires_at"},
  "record": {"id","doc_type","source":{"id","name"},"ocr_confidence","status_reason"},
  "document": {"signed_url","pages":[{"page":1,"image_url","width","height"}]},
  "decision": {"aggregate_score","reasons":[],"thresholds_applied":{},"reasoning_trace":"…"},
  "resources": [{
     "id","resource_type","validation_status","validation_issues":[],"score":0.91,
     "fields":[{
        "field_key","label","value","found","basis","confidence","score","concerns":[],
        "span":{"page","quote","bbox","char_start","char_end"},
        "coding":{"system","code","display","match_confidence","candidates":[{"code","display","score"}]}|null
     }]
  }]
}
```
Signed URLs short-lived (5 min), refreshed by the client before expiry. Holdback tasks do not reveal the "would have auto-committed" flag.

## 6. Submit contract
```json
{
  "decisions": [
    {"field_key":"medication[0].dose_value","action":"accept"},
    {"field_key":"medication[0].frequency","action":"correct","value":"twice daily","code":null,"note":"printed BID"},
    {"field_key":"diagnosis[1].text","action":"correct","value":"Type 2 diabetes mellitus","code":{"system":"snomed","code":"44054006","display":"Diabetes mellitus type 2"}},
    {"field_key":"allergy[0].reaction","action":"reject"}
  ],
  "overall": "approve"
}
```
Rules:
- Every field that is **not above its threshold equivalent** (any field with score < resource threshold, any `found=false` required field, any field with `concerns`) must receive a decision; other fields default to `accept` implicitly (implicit accepts are stored as `accept` rows so the labeled set is complete). Missing decision → 422 `DECISION_MISSING` listing `field_key`s.
- `accept`: keeps value/code. `correct`: `value` and/or `code` required (`note` optional ≤ 300 chars); `code.system/code` must exist in `terminology_concepts` (`INVALID_CODE`) — reviewers pick from search (`GET /api/terminology/search?q&system&resource_type`, roles reviewer/admin) not free text. `reject`: marks field "not found" (removes it from the resource; allowed for non-required fields; rejecting a required field makes the resource invalid → reviewer must choose `overall: 'reject_record'`).
- Corrected values supplied by the reviewer for a `found=false` field have no source span; they are stored with `source_span = {manual:true, page?, quote?}` (reviewer may optionally pick a quote from the viewer); provenance flags them `reviewer_supplied`.
- `overall: 'approve'`: server rebuilds affected resources with the builders (spec 07 §4) from final values, re-runs validation (own checks + FHIR validator). Any failing resource → 422 with issues; nothing is committed and the task stays claimed. On success, in one transaction: update `mapped_resources`/`extracted_fields`, insert `review_corrections` (one row per field decision), mark task `completed`, set record `in_review` → call `commit_record(record, 'human', reviewer_id)` → audit `review.submitted` `{task_id, accepted, corrected, rejected}` + `record.committed`.
- `overall: 'reject_record'`: requires `note`; record → `rejected` (`status_reason='reviewer_rejected'`), task `completed`, corrections still stored (`reject` for fields), audit `record.rejected`.
- Reviewers cannot approve records they submitted (separation of duties is N/A: reviewers don't submit). A reviewer cannot submit if their role/active status changed (RLS/profile check).

## 7. Workspace UI (`/review/[taskId]`)
Layout (≥1280 px): three panes — **Source** (left, 40%), **Draft fields** (center, 35%), **Trace & decision** (right, 25%). Below 1024 px panes become tabs.
- **SourceViewer:** page thumbnails, zoom/fit, page navigation; selecting a field draws its bbox on the page and scrolls to it; selecting text in the page offers "Use as citation" for manual corrections. Toggle OCR text overlay.
- **DraftFieldList:** grouped by resource card; each `FieldRow`: label, value, citation quote (truncated, click to jump), `ConfidenceBar`, basis chip, concerns chips, actions **Accept (A)**, **Correct (C)**, **Reject (R)**. Correct opens an inline editor (typed value; for coded fields a `CodePicker` combobox querying terminology search with the model's candidates pre-listed). Rows needing a decision are visually grouped on top ("Needs your decision (n)"), the rest collapsed ("Auto-accepted unless changed (m)"). Progress counter, "Accept all remaining" is **not** offered for fields needing a decision.
- **Trace panel:** routing reasons, per-resource score vs threshold, deterministic reasoning text, validation issues with FHIR rule ids, optional narrative (labeled non-authoritative), consent card.
- **SubmitBar (sticky):** counts (accepted / corrected / rejected / pending), buttons *Approve & commit*, *Reject record*, *Release task*. Approve disabled until all required decisions made. Shows validation errors returned by the server inline at the offending field.
- Keyboard: `J/K` next/prev field, `A/C/R`, `Enter` confirm correction, `Esc` cancel edit, `[` `]` previous/next page; focus management and `aria-live` announcements for decisions.
- Unsaved edits: client keeps draft decisions in Zustand + `sessionStorage` (no PHI beyond field keys/values already in view; cleared on submit/release); `beforeunload` warning.
- Queue page `/review`: filters (source, resource type, kind, mine), table with priority chip, age, reasons; "Claim next" button claims the top open task for the reviewer.

## 8. Data produced for calibration
`review_corrections` row per field: `original_value`, `corrected_value`, `original_code`, `corrected_code`, `source_span`, `action`, `source_id`, `reviewer_id`, `reviewed_at`. Weekly job (spec 13) anonymizes and proposes eval-set additions (`eval_samples.origin='production_correction'`), never auto-adding.

## 9. Edge cases
- Two reviewers click claim simultaneously: conditional update `where status='open'` — second gets 409.
- Reviewer idle > lock time: lock expires; their later submit → 409 `LOCK_LOST`, UI offers to re-claim and keeps their draft decisions.
- Source image fails to load: viewer shows error + retry; **approve disabled** until the page image for cited spans is loaded at least once (prevents blind approvals).
- Reviewer corrects a field making resource invalid (e.g. clears dose): server validation 422; task stays open.
- Reviewer selects a code not in candidate list but valid in terminology: allowed; flagged `reviewer_code_override` in the stored correction.
- Record consent revoked while in review: claim/submit fail with `CONSENT_NO_LONGER_VALID`; record → `blocked_consent`, PHI purged (spec 05).
- Admin reassigns (admin `release` then reviewer claims).
- Task for a `rejected`/`committed` record (stale): GET returns 410 `TASK_CLOSED`.
- Large record (> 60 fields): virtualized list, decisions state keyed by `field_key`.
- Concurrent edits to thresholds don't affect an in-flight review (thresholds are stored with the decision).

## 10. Acceptance criteria
1. Reviewer can correct one field and approve without re-keying other fields; only that field differs in `review_corrections` from `accept` rows.
2. Every field has exactly one `review_corrections` row after submit (accept/correct/reject).
3. Submitting a correction that yields an invalid FHIR resource returns 422 with the rule path and commits nothing.
4. Corrected code not present in `terminology_concepts` is rejected (422 `INVALID_CODE`).
5. Lock semantics: second claimer gets 409; expired lock allows re-claim; submit after expiry gets 409.
6. Holdback tasks look identical to normal escalations in the reviewer UI.
7. Keyboard-only completion of a full review is possible (Playwright test).
8. `review.claimed`, `review.submitted`, `record.committed` audit events exist with reviewer id; the committed resource's provenance has `reviewer_id` and `extraction_method='ai_extracted_human_reviewed'`.
9. Review time per task is derivable: `completed_at − claimed_at` stored for metrics.
