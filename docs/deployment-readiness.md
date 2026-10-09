# Deployment readiness sweep (2026-10-08)

Status of everything between "built" and "live". Blockers must be closed before the first deploy. Items marked "pilot OK" may ship with a stated limit.

## A. Blockers

| # | Item | Owner | Done when |
|---|---|---|---|
| 1 | **Nothing is committed.** `nextjs-app/`, `docs/specs`, `docs/engineering`, `docs/security`, `docs/testing`, `.env.example` are all untracked; only `README.md` is modified. Netlify deploys from a repository | Claude (on request) / you | Work committed on a branch and pushed to the Git host Netlify watches. `.env.local` stays untracked (already ignored) |
| 2 | ~~**Worker on Netlify.** `netlify/functions/worker-tick.mts` calls `/api/worker/tick` once a minute, but the tick route runs as a Next.js function with a short time limit, while `WORKER_TICK_MAX_SECONDS` is 50 and one model call may take 60 s. A tick can be cut off mid-job | Decision (you) + Claude | Choose: (a) keep the route and set `WORKER_TICK_MAX_SECONDS` and `LLM_REQUEST_TIMEOUT_MS` below the plan's limit, or (b) run the tick as a Netlify background function (up to 15 min). Then prove it with one real PDF on the deployed site~~ **Built 2026-10-08:** a worker pass now keeps claiming jobs until its time budget ends (previously one stage per minute); with `WORKER_HOST_LIMIT_SECONDS=60` it stops starting jobs early enough to finish a model call inside the host limit; (superseded) the background function `worker-run` was removed because it was never proven to start: the tick route is now the only worker entry. The scheduler (`worker-tick`, every minute) and the intake call it directly, and a pass that runs out of time while work remains starts the next pass itself. **Still to do:** set `WORKER_HOST_LIMIT_SECONDS=60` and `LLM_REQUEST_TIMEOUT_MS=35000` in Netlify, and prove it with one real PDF on a preview deploy (scheduled functions run only on published deploys) |
| 3 | **Run `supabase/rls-policies.sql`** (includes migration 0008) on the production project; its three verification queries return no rows | You | Done and confirmed |
| 4 | **Run all migrations 0001–0008 on production** and confirm with System check (no "Broken") | You | System check green |
| 5 | **Run `tests/sql/acceptance.sql`** against a non-production copy of the schema (it exercises commit, review and audit functions; never run against real data) | You | All assertions pass |
| 6 | **Supabase dashboard settings**: sign-ups disabled, password length 12+, refresh-token rotation, redirect URLs limited to the live address, bucket private, backups on (list in `docs/security/security-plan.md`) | You | Each box ticked |
| 7 | **Production environment variables in Netlify**: Supabase URL/anon/service keys, `WORKER_SECRET` (32+ random characters, different from local), `APP_BASE_URL` = live https address (the worker function and the origin check both use it), model provider/key/models/prices, `LLM_DAILY_BUDGET_USD`, `SYSTEM_AUTOCOMMIT_ENABLED=false`, `CONSENT_MODE` | You | System check shows environment items OK |
| 8 | **Confirm the PDF date fix** with the same document: re-run from "Extract fields" and check admission/discharge dates. If still missing, send the `dropped` list from the newest extraction audit event | You | Dates appear, or cause identified |
| 9 | **First admin user and organisation** exist in production (sign-ups are off, so the first user must be created in Supabase) | You | You can sign in on the live site |

## B. Gaps to close or accept (pilot OK unless stated)

| # | Item | Notes |
|---|---|---|
| 10 | **No browser end-to-end tests.** `tests/e2e/` is empty and Playwright is not installed. CLAUDE.md Stage 5 asks for E2E of sign-in, ingest and review | Claude can add Playwright covering sign-in, submit a text note, review and accept. Needs a test Supabase project or seeded local one |
| 11 | ~~**Netlify config duplicates headers** (`netlify.toml` sets `Referrer-Policy: no-referrer` and HSTS `preload`; `next.config.mjs` sets `strict-origin-when-cross-origin`) | Pick one place. Remove the `[[headers]]` block in `netlify.toml` (the app sets them) unless you want `preload`, which is hard to undo~~ Done: block removed from `netlify.toml` |
| 12 | **OCR not built.** Scanned or image-only documents go to review as "OCR unavailable" | Pilot OK if sources send typed PDFs, text or HL7. Otherwise build before launch |
| 13 | **Terminology is sample data** (codes written from memory) and embeddings are not seeded | Pilot OK only if the sample set is declared as such; real use needs licensed SNOMED/LOINC/ICD-10 |
| 14 | **"No known allergies" behaviour** undecided | Needs a clinical/product decision before real data |
| 15 | **Dashboard computes live** from the database, with no scheduled aggregation | Pilot OK; slow at volume |
| 16 | **Shared helper for reading related rows** (review, incident, dashboard, artifact services) not extracted | Hardening, low risk today |
| 17 | **Two PostCSS advisories** inside Next 14 (fixed in Next 16) | Build-time only; schedule the Next 16 upgrade after launch |
| 18 | **CSP allows inline scripts** (Next 14 limitation) | Plan nonces later |
| 19 | **Monitoring:** `NEXT_PUBLIC_SENTRY_DSN` and `LOG_LEVEL` exist in `.env.example`, but no error tracking or alerting target is confirmed. Alerts (`sendAlert`) need a destination | Pilot OK with Netlify logs only; set an alert destination before real traffic |
| 20 | **Penetration test** before real patient data | Recommended, not a technical blocker |

## C. Smoke test on the live site (after deploy)
1. Sign in; you land on the Dashboard; System check is green.
2. Submit a typed discharge-summary PDF; it reaches "Needs review" (auto-commit is off) without a manual nudge.
3. Open it: fields, dates, codes and the pipeline row agree with the status.
4. As reviewer, correct one field and approve; record shows committed and the Audit page shows the chain.
5. Re-run from "Extract fields" as admin; the timeline resets and finishes.
6. Sign out; reopen the site; the sign-in page appears.
7. Wrong password 11 times in a minute: rate-limited.
8. Check the response headers and that `npm run build:check` passed on the same commit.

## D. After launch
Stage 7 hardening follow-ups (nonce CSP, pen test, Next 16), OCR provider, licensed terminology, calibration of thresholds on real data before turning on any source's auto-commit.
