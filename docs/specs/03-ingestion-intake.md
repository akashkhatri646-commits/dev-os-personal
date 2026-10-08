# Spec 03 — Multi-Format Ingestion Intake [MVP] (FR1, US-001)

## 1. Goal
Accept scanned PDFs, fax images, non-standard HL7v2 messages and free-text notes, tagged with source and patient identifier, store the original safely, de-duplicate, and enqueue the pipeline — without writing a per-provider parser.

## 2. Inputs

| Kind (`input_kind`) | Accepted MIME / extension | Notes |
|---|---|---|
| `pdf` | `application/pdf` (.pdf) | Scanned or digital; ≤ `OCR_MAX_PAGES` (40) |
| `image` | `image/png`, `image/jpeg`, `image/tiff` | Fax scans; multi-page TIFF allowed |
| `hl7v2` | `.hl7`, `.txt` with first line starting `MSH\|`; or `text` field starting `MSH\|` | Pipe-delimited, any version 2.x, any Z-segments |
| `text` | `text/plain`, or `text` form field | Free-text clinical note, ≤ 200,000 chars |

Detection order: declared MIME → magic bytes (`%PDF-`, PNG `89504E47`, JPEG `FFD8FF`, TIFF `49492A00`/`4D4D002A`) → HL7 header. **Magic bytes override extension/MIME**; mismatch → 415 `UNSUPPORTED_MEDIA_TYPE`. Size limit `MAX_UPLOAD_BYTES` (25 MB) → 413. Empty file → 422.

Required metadata: `source_id` (uuid), `patient_identifier {type: 'abha'|'mrn', value}`, `doc_type` (`discharge_summary` in MVP), `data_categories[]` (subset of `DischargeSummary, Prescription, DiagnosticReport, OPConsultation, ImmunizationRecord, HealthDocumentRecord, WellnessRecord` — ABDM HI types; MVP default `['DischargeSummary']`).

Patient identifier validation:
- ABHA number: 14 digits, hyphens optional (`^\d{2}-?\d{4}-?\d{4}-?\d{4}$`); normalized to 14 digits. ABHA address (`name@abdm`) is not accepted in MVP (422 `ABHA_FORMAT`).
- MRN: 1–64 chars, `^[A-Za-z0-9\-_/\.]+$`, scoped to the source.
- Hash for lookup: `HMAC_SHA256(PATIENT_ID_HMAC_KEY, type + ':' + normalized)`; encrypted copy via AES-256-GCM (`PATIENT_ID_ENC_KEY`). Plaintext is never persisted or logged.

## 3. API: `POST /api/ingestions`

Auth: user (roles IE, admin) via session **or** `X-Source-Key` (key's source must equal `source_id`, otherwise 403). Content types: `multipart/form-data` (fields above + `file` or `text`) or `application/json` for feed integrations: `{source_id, patient_identifier, doc_type, data_categories, text?, file_base64?, filename?}` (base64 ≤ 25 MB decoded).
Headers: `Idempotency-Key` (optional, ≤ 128 chars).

Processing (in order; abort + no side effects on any failure before step 6):
1. Authenticate, role/source check, rate limit (120/min per source key; 60/min per user).
2. Parse and validate (Zod `submitIngestionSchema`); source must exist in org and not be hard-disabled; `doc_type` must be in source's `doc_types` and `ENABLED_DOC_TYPES`.
3. Detect kind; reject unsupported.
4. Compute `content_sha256` of raw bytes (text: UTF-8 bytes of normalized newlines).
5. Dedupe (ignoring records in `blocked_consent`): if `(source_id, content_sha256)` or `(source_id, idempotency_key)` exists → return `200 {data:{record_id, status, duplicate:true}}` (audit `ingest.duplicate`). Different patient identifier with identical content → 409 `CONTENT_PATIENT_MISMATCH` (prevents consent-bypass by re-submitting for another patient).
6. Upsert `patients` (by hash within org/source), upload file to `source-documents/{org_id}/{record_id}/{sanitized_filename}` (service role, `upsert:false`), insert `ingestion_records(status='received')`, `documents`, enqueue `pipeline_jobs(stage='consent_check')`, `audit ingest.received` — DB writes inside one RPC/transaction wrapper; if storage upload succeeded but DB fails, delete the object (compensation).
7. Respond `202 {data:{record_id, status:'received', duplicate:false}}` within 2 s (no OCR/LLM inline).

Filename sanitization: strip path, allow `[A-Za-z0-9._-]`, max 100 chars, else `document`.

Other endpoints (read side): `GET /api/ingestions`, `GET /api/ingestions/:id`, `GET /api/ingestions/:id/document`, `POST /api/ingestions/:id/retry` as in engineering doc §9.4. Details:
- List filter: `status` (comma list), `source_id`, `from`, `to`, `q` (record id prefix). Returns `{id, source_id, source_name, doc_type, status, status_reason, created_at, completed_at, aggregate_score?}`.
- Detail returns: record, `stages` (from audit events), `consent` (result, artifact_ref, matched_scope), `ocr` (confidence per page), `fields` (extracted + scores), `resources` (mapped + validation), `decision`, `review` (task status, reviewer), `fhir_resource_ids`.
- `GET …/document` returns `{url, expires_in: SIGNED_URL_TTL_SECONDS, pages, mime_type}`; creates a Supabase signed URL for the stored object; audit `document.accessed`. Not available for `blocked_consent` records (403 `CONSENT_BLOCKED`) since content must not be viewed.
- `retry` allowed from `failed` or `needs_review` with reason `llm_error|stage_error|low_ocr_quality`; resets to the failed stage; 409 if `blocked_consent`, `committed`, `auto_committed` or `rejected`; max 3 manual retries per record (`retry_count` in `status_reason` audit) → 409 `RETRY_LIMIT`.

## 4. HL7v2 handling (`src/server/services/hl7/parser.ts`)
No schema-specific mapping is required. The parser:
1. Normalize line endings (`\r`, `\r\n`, `\n` → `\r`), strip MLLP framing bytes (`0x0B`, `0x1C 0x0D`).
2. Read encoding characters from `MSH-2` (default `^~\&`) and field separator from `MSH-1`.
3. Split into segments, then fields (`SEG-n`), repetitions, components, sub-components, with HL7 un-escaping (`\F\ \S\ \T\ \R\ \E\ \.br\`).
4. Produce `normalized_text`: one "page" per message; one block per segment with id `SEG{index}` and text `PID-5 Patient Name: …` lines (`<SEG>-<n> <value>`), preserving unknown `Z*` segments verbatim. Block bbox absent.
5. Return `parse_warnings[]` (missing MSH, unknown version, truncated segment). A message that cannot be tokenized (no `MSH`) → 422 at submission. Multiple messages in one payload (batch `FHS/BHS`) → split into one record per message; response returns `record_ids[]`.
HL7 text is not OCRed; OCR confidence is recorded as `1.0` with `ocr_engine='hl7-parser'`.

## 5. UI: `/ingest`
- Left: form. Source select (only sources whose `doc_types` include selection), patient identifier type + value (inline format validation), data categories multi-select, doc type, content area with tabs **Upload file** (dropzone, multiple files allowed, each becomes its own record) and **Paste text/HL7**.
- Client checks: type, size, ABHA format. Server remains authoritative.
- Right/below: **Recent submissions** table with `StatusBadge`, source, time, and link to `/records/[id]`; live updates via Supabase Realtime on `ingestion_records` filtered by `org_id`; polling fallback every 10 s when channel errors.
- States: empty ("No records yet. Submit a discharge summary to start."), uploading (progress per file), failed row (error message + retry), blocked consent (red chip "Blocked: consent <reason>").
- Accessibility: dropzone is a `<button>` + hidden file input; announcements via `aria-live="polite"` for status changes.
- Sources with `auto_commit_enabled=false` show an info chip "Manual review only".

## 6. Edge cases
- Same file uploaded twice (even with different filename) → duplicate response, no second record.
- Password-protected or corrupted PDF: normalize stage fails parse → `needs_review` reason `unreadable_document` with guidance to re-upload (not retried).
- Very large page count → rejected at submission when detectable (PDF page count via `pdf-lib`), else at normalize with `needs_review: too_many_pages`.
- Patient not previously known: patient row created at submission (identifier only). Consent check then fails with `missing` unless a consent artifact already exists for that patient.
- Concurrent identical submissions: unique index race → second insert fails; handler catches unique violation and returns the first record as duplicate.
- Clock/timezone: all times UTC.
- Source paused: ingestion still accepted (records go to manual review); UI shows banner.
- Feed JSON with both `text` and `file_base64` → 422.
- Prompt-injection text inside documents is data (see spec 06 §8); intake does no content interpretation.

## 7. Acceptance criteria
1. Valid PDF + metadata → 202 in ≤ 2 s; record, document, job, audit rows exist; object stored in private bucket at `{org}/{record}/…`.
2. EXE renamed `.pdf` → 415; 26 MB file → 413; invalid ABHA → 422 `ABHA_FORMAT`.
3. Re-submitting identical content returns the original `record_id` with `duplicate:true` and creates nothing.
4. Same content with a different patient → 409.
5. An HL7v2 message with unknown `ZXX` segments is ingested and its text appears in `normalized_text` without code changes.
6. Source key for source A cannot submit for source B (403).
7. Document URL expires after `SIGNED_URL_TTL_SECONDS` and each access is audited; blocked-consent records cannot be opened.
8. No patient identifier plaintext appears in DB, logs or audit payloads.
