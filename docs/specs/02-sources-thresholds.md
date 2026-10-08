# Spec 02 — Provider Sources, API Keys and Routing Thresholds [MVP; per-resource tuning UI polish GA]

## 1. Goal
Model each hospital/lab/clinic feed as a `provider_source`, give it an ingestion API key, and hold its versioned routing thresholds and auto-commit status. Auto-commit is **off by default** and can only be turned on after the source passes its labeled-sample eval (PRD staged-exposure).

## 2. Data
Tables: `provider_sources`, `source_api_keys`, `routing_thresholds` (see schema). Rules:
- `provider_sources.auto_commit_enabled=true` requires `eval_status='passed'` (DB check `chk_source_autocommit_requires_eval`).
- On source creation, the API inserts default thresholds in one transaction: `resource_type='*'` → `DEFAULT_THRESHOLD` (0.97); `MedicationRequest`, `AllergyIntolerance`, `Observation` → `HIGH_RISK_THRESHOLD` (0.99); all `version=1`, `active=true`, `reason='default at creation'`.
- Threshold change = insert new row with `version = max+1`, set previous `active=false` (single transaction). Never update a threshold in place.
- Lookup precedence at routing time: exact `resource_type` active row → `'*'` row. If neither exists → treat as `1.0` (fail closed).
- Validation: `0.5 ≤ threshold ≤ 0.999`. For `MedicationRequest` and `AllergyIntolerance`, minimum is `0.95` (reject lower with 422 `THRESHOLD_TOO_LOW`).
- API key format: `hik_<8-char prefix>_<40 chars base62>`. Stored as `sha256(SOURCE_KEY_PEPPER + key)` hex in `source_api_keys.key_hash`; plaintext returned once at creation/rotation. At most one non-revoked key per source (rotation revokes old key immediately).

## 3. API

| Method/Path | Roles | Request | Response | Errors |
|---|---|---|---|---|
| `POST /api/sources` | IE, admin | `{name 2..80, provider_type, size_class, region?, primary_language (ISO 639-1, default 'en'), doc_types[] (MVP: only discharge_summary accepted; MVP1 adds lab_report), consent_regime='abdm'}` | `201 {id, api_key}` | 409 `NAME_TAKEN`; 422 (`hipaa` rejected until ITER with `REGIME_NOT_ENABLED`) |
| `GET /api/sources` | all | `?limit&cursor` | `{data:[{id,name,provider_type,size_class,auto_commit_enabled,eval_status,pause_reason,holdback_pct,queue_depth,created_at}]}` | |
| `GET /api/sources/:id` | all | — | source + `thresholds:[{resource_type,threshold,version,reason,created_at}]` + `key_prefix` + `eval` summary | 404 |
| `PATCH /api/sources/:id` | IE, admin | any of `name, size_class, region, primary_language, doc_types, holdback_pct (0..100)` | `200` | 422; `holdback_pct<5` rejected unless `auto_commit_enabled=false` (`HOLDBACK_TOO_LOW`) |
| `PUT /api/sources/:id/thresholds` | IE, admin | `{resource_type, threshold, reason 5..300}` | `200 {version}` | 422 `THRESHOLD_TOO_LOW`; `reason` mandatory |
| `GET /api/sources/:id/thresholds/history` | IE, admin | — | all versions | |
| `POST /api/sources/:id/rotate-key` | admin | — | `{api_key}` | |
| `POST /api/sources/:id/enable-auto-commit` | admin | `{note 5..300}` | `200` | 409 `EVAL_NOT_PASSED` |
| `POST /api/sources/:id/pause` | admin | `{reason 5..300}` | `200` | |
| `POST /api/sources/:id/resume` | admin | `{note 5..300}` | `200` | 409 `EVAL_NOT_PASSED` |
| `POST /api/sources/:id/flag-poor` | reviewer, admin | `{note}` | `201` | |
| `POST /api/sources/:id/run-eval` | admin | — | `202 {eval_run_id}` runs onboarding eval (spec 12 §5) | 409 `INSUFFICIENT_LABELED_SAMPLES` if <50 samples with `source_id` |

Eval passing: the onboarding eval run sets `eval_status='passed'` only if metrics meet `Extraction F1 ≥ 0.97`, `grounded=100%`, `mapping exact match ≥ 0.95` on that source's samples. Otherwise `failed`.

Audit events: `source.created`, `source.updated`, `source.key_rotated`, `threshold.changed` (payload: `source_id, resource_type, old, new, version`), `source.auto_commit_enabled`, `source.paused`, `source.resumed`.

## 4. Backend implementation
- `src/server/services/sources/sourceService.ts`: `createSource`, `updateSource`, `setThreshold`, `getEffectiveThreshold(sourceId, resourceType)`, `pause`, `resume`, `enableAutoCommit`.
- `getEffectiveThreshold` is also used by routing (spec 08); it loads all active rows for the source once per record (cache for the duration of the stage only).
- Source key authentication: `authenticateSourceKey(header)` hashes with pepper, looks up non-revoked row, returns `{sourceId, orgId}`; constant-time compare; failure → 401 and `auth.login_failed`-style audit `source.key_rejected` (payload prefix only).

## 5. UI
- `/sources` table: name, type, size, status chip (**Manual only** / **Auto-commit on** / **Paused**), eval status, queue depth, last record time.
- `/sources/new`: form with the fields above; after submit a one-time modal shows the API key with copy button and "I have stored this key" checkbox gating close.
- `/sources/[id]`: tabs **Overview** (status, key prefix, rotate), **Thresholds** (`ThresholdMatrix`: rows resource types, current value, version, edit dialog requiring reason; history drawer), **Safety** (pause/resume/enable auto-commit with `ConfirmDialog` + required note; shows eval status and "Run onboarding eval"), **Activity** (recent records).
- Controls hidden by role (e.g. reviewer sees read-only). Warning banner when a source is paused or `flagged_poor`.

## 6. Edge cases
- Duplicate name in same org → 409. Same name in other org fine.
- Creating a source with `doc_types` including `lab_report` before MVP1 → 422 `DOC_TYPE_NOT_ENABLED` (feature flag `ENABLED_DOC_TYPES` in constants).
- Rotating key while a submission is in flight: in-flight request authenticated before rotation completes normally; subsequent requests with the old key fail.
- Two admins change the same threshold concurrently: unique `(source_id, resource_type, version)` makes the second insert fail → 409 `CONFLICT`, UI reloads current value.
- Enabling auto-commit while source `flagged_poor` is allowed but requires `note`; the UI shows a warning.
- Deleting sources is not supported (history/audit integrity); only pause.

## 7. Acceptance criteria
1. New source has auto-commit off and the 4 default threshold rows at version 1.
2. Enable-auto-commit returns 409 until `eval_status='passed'`; DB check also blocks a direct SQL update.
3. Threshold change creates a new version, deactivates the old one, requires a reason, and is audited.
4. Setting MedicationRequest threshold to 0.90 is rejected with `THRESHOLD_TOO_LOW`.
5. API key is shown once; DB contains only the hash; rotating invalidates the old key at once.
6. Reviewer cannot create sources, edit thresholds, or pause.
7. Routing resolves exact-type threshold before `'*'`, and uses 1.0 when none exist.
