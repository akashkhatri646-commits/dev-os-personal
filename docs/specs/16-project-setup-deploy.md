# Spec 16 — Project Setup, Dependencies, Scripts, Netlify and Seeding

Input for Stage 3 (`/frontend-setup`) and the backend scaffolding that follows. Folder structure is exactly engineering doc §11.

## 1. Runtime and tooling
Node.js 20 LTS · npm (lockfile committed) · TypeScript 5 strict (`noUncheckedIndexedAccess`) · ESLint (next/core-web-vitals + `@typescript-eslint`) · Prettier · Husky + lint-staged (lint, typecheck on staged) · `server-only` package for server modules.

## 2. Dependencies
| Purpose | Packages |
|---|---|
| Framework | `next@14`, `react`, `react-dom` |
| UI | `tailwindcss`, `postcss`, `autoprefixer`, `tailwindcss-animate`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `@radix-ui/*` (via shadcn CLI), `recharts`, `@tanstack/react-table`, `react-pdf` (+ `pdfjs-dist`) |
| State/data | `@tanstack/react-query`, `zustand`, `react-hook-form`, `@hookform/resolvers`, `zod` |
| Supabase | `@supabase/supabase-js`, `@supabase/ssr` |
| LLM/embeddings | `openai` (official SDK; its `AzureOpenAI` client covers in-region Azure deployments) or plain `fetch` against the Chat Completions and Embeddings endpoints |
| OCR | `@aws-sdk/client-textract`, `@google-cloud/documentai` (load lazily by `OCR_PROVIDER`) |
| Documents | `pdfjs-dist` (server text layer), `pdf-lib` (page count), `sharp` (raster/preprocess), `franc-min` (language) |
| FHIR | `@types/fhir`, `fhirpath`, (validator service client via `fetch`) |
| Utilities | `pino`, `@sentry/nextjs`, `date-fns`, `p-limit`, `fast-levenshtein`, `nanoid` |
| Testing | `vitest`, `@vitest/coverage-v8`, `msw`, `@playwright/test`, `@axe-core/playwright`, `supabase` CLI (dev), `k6` (external) |
`sharp`/`pdfjs-dist` require Node runtime (route segment config `export const runtime = 'nodejs'` on pipeline/worker routes; Edge runtime is not used).

## 3. NPM scripts (`package.json`)
```
dev, build, start, lint, typecheck, test (unit), test:int, test:e2e,
db:types        -> supabase gen types typescript --linked > src/types/database.ts
seed:test       -> tsx scripts/seed-test.ts
seed:prompts    -> tsx scripts/seed-prompts.ts
seed:terminology-> tsx scripts/seed-terminology.ts <path-to-licensed-files>   (loads SNOMED/LOINC/ICD-10 + embeddings in batches of 100)
eval            -> tsx evals/runners/index.ts
prompts:activate-> tsx scripts/activate-prompt.ts <id>
```

## 4. Netlify (`netlify.toml`)
```toml
[build]
  command = "npm run build"
  publish = ".next"
[[plugins]]
  package = "@netlify/plugin-nextjs"
[functions]
  node_bundler = "esbuild"
[functions."worker-schedule"]
  schedule = "* * * * *"
[[headers]]
  for = "/*"
  [headers.values]
    X-Content-Type-Options = "nosniff"
    X-Frame-Options = "DENY"
    Referrer-Policy = "no-referrer"
    Permissions-Policy = "camera=(), microphone=(), geolocation=()"
    Strict-Transport-Security = "max-age=63072000; includeSubDomains; preload"
```
- `netlify/functions/worker-schedule.ts`: scheduled function that `POST`s `${APP_BASE_URL}/api/worker/tick` with `X-Worker-Secret`, plus (hourly/nightly) `/api/internal/metrics/run`, (weekly) `/api/internal/calibration/run`, (daily) `/api/internal/audit/verify` — gated by the schedule expression via separate scheduled functions.
- Route handler limits: set `export const maxDuration = 60` on `api/worker/tick` (verify against the Netlify plan limit; if the plan caps lower, reduce `WORKER_TICK_MAX_SECONDS`/chunk size accordingly — see spec 04 §3).
- Content-Security-Policy set in `next.config.js` headers: `default-src 'self'; img-src 'self' data: blob: https://<supabase-project>.supabase.co; connect-src 'self' https://<supabase-project>.supabase.co wss://<supabase-project>.supabase.co; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'` (tighten with nonces in Stage 7).
- Environment variables set in Netlify UI per context (production/deploy-preview). Deploy previews use a separate Supabase project and `CONSENT_MODE=stub`, `SYSTEM_AUTOCOMMIT_ENABLED=false`.

## 5. Supabase project setup (one-time)
1. Create project in the India (Mumbai, `ap-south-1`) region.
2. Auth → Providers → Email: enable; **disable "Allow new users to sign up"**; set site URL and redirect URLs.
3. SQL Editor: run `docs/specs/supabase-schema.sql` once.
4. Run the bootstrap SQL at its end (first org + admin profile).
5. Realtime: confirm `ingestion_records` and `review_tasks` are in the `supabase_realtime` publication.
6. Storage: confirm bucket `source-documents` exists and is private.
7. `npm run db:types` to generate `src/types/database.ts`.
8. `npm run seed:prompts`, `npm run seed:terminology` (licensed content), `npm run seed:test` (non-production only).
9. Optional: enable `pg_cron` and schedule `select net.http_post(...)` tick as a fallback to the Netlify scheduler.

## 6. Migrations after the baseline
Baseline = `supabase-schema.sql` (copied to `supabase/migrations/0001_baseline.sql` in Stage 3). Further migrations are numbered files:
| File | Content | Release |
|---|---|---|
| `0002_source_functions.sql` | atomic source creation, threshold versioning, key rotation (also folded into the baseline) | MVP |
| `0003_audit_functions.sql` | per-row audit hash and chain-link check (also folded into the baseline) | MVP |
| `0004_mapped_resource_flags.sql` | `flags` column on `mapped_resources` (also folded into the baseline) | MVP |
| `0005_mapped_resource_source_ref.sql` | `source_ref` column on `mapped_resources` (also folded into the baseline) | MVP |
| `0006_review_functions.sql` | `submit_review`, `reject_review`, `release_expired_review_locks` (also appended to the baseline) | MVP |
| `0007_safety_controls.sql` | incident close-out columns, `llm_spend_daily` with `add_llm_spend` / `get_llm_spend` (also appended to the baseline) | MVP |
| `0008_rate_limit.sql` | `rate_limit_events`, `rate_limit_hit` (database-backed rate limiting) | MVP |
| `0009_fix_commit_record_found.sql` | fixes an ambiguous column in `commit_record` that broke every automatic commit (also folded into the baseline) | MVP |
| `0010_source_evaluation.sql` | `basis` on `eval_runs` and `eval_basis` on `provider_sources`, for the source evaluation (also folded into the baseline) | MVP |
| `0008_source_hip_id.sql` | `alter table provider_sources add column hip_id text;` | MVP1 |
| `0009_metrics.sql` | `refresh_source_metrics(date)`, `calibrators` table + RLS (select IE/admin) | GA |
| `0010_consent_regime_hipaa.sql` | HIPAA authorization tables/enums use | ITER |
| `0011_system_settings.sql` | optional runtime kill-switch table (if env-only switch proves insufficient) | GA |
Every migration is idempotent where possible and has a down note in comments.

## 7. Code conventions (enforced by lint/CI)
- Naming per engineering doc §12. Route handlers contain no business logic; only `src/server/**` imports vendor SDKs and the service-role client (`import 'server-only'`; ESLint `no-restricted-imports` blocks them elsewhere).
- Zod schemas shared in `src/lib/validation/*.ts`; every API route declares request and response schemas.
- No `any` in `src/server/**`; no `console.log` (use `logger`); logger redacts keys matching `patient|abha|mrn|value|quote|text|authorization|apikey`.
- Env access only via `src/server/config/env.ts` (server) and `src/lib/publicEnv.ts` (public vars).
- Commit style: Conventional Commits; PRs require CI green.

## 8. Order of implementation (Stage 4 feature order)
1. Foundation: project scaffold, env validation, Supabase clients, `route()` wrapper, error model, logger, design tokens (specs 00, 11, 16).
2. Auth/roles/user admin (01).
3. Sources & thresholds (02).
4. Audit service + commit SQL smoke tests (10 §4 first).
5. Ingestion intake (03) + queue/worker skeleton (04 §2–3).
6. Consent stub (05).
7. Normalization (04 §4).
8. Extraction + grounding (06) + eval harness v0 (12).
9. Mapping + validation (07).
10. Scoring + routing (08) + commit stage (10 §2).
11. Review queue (09).
12. Record detail, audit UI, FHIR read (10/11).
13. Safety controls (14).
14. MVP acceptance run (15 §10 measurement launch).
Then MVP1 (lab reports, ABDM sandbox), then GA (13).
