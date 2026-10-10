# Deployment runbook — pilot with test records

Do the steps in order. Each ends with a check. Commands run in a terminal opened in `dev-os-personal` unless stated.

## 1. Put the code on GitHub
```bash
git status
git commit -m "Add Trust at the Edge MVP app, specs, security pass and Netlify worker"
git push -u origin release/mvp-pilot
```
If `git status` says nothing to commit, the commit already exists; run only the push.
Check: the branch `release/mvp-pilot` appears on GitHub. Open a pull request into `main` and merge it when you are ready to publish (Netlify publishes from the branch you tell it to).

## 2. Check the database functions on your current (development) project
This test creates data inside a transaction and ends with an error on purpose, so nothing is kept. Run it while the worker is idle (stop `npm run dev:all`).
1. Supabase → your development project → SQL Editor → New query.
2. Paste the whole of `nextjs-app/tests/sql/acceptance.sql` and run.
3. Read the error message: `ACCEPTANCE RESULT: N passed, 0 failed, M skipped`. Failed must be 0. Tell me any FAIL line.

## 3. Create the production Supabase project
1. supabase.com → New project. Name it for production. Region **India (Mumbai)** if patient data will be in India (the specs require in-region storage). Choose a strong database password and save it in your password manager.
2. Project Settings → API: copy three values for later: Project URL, `anon` key, `service_role` key. The service-role key is a secret: never paste it in chat, code or the browser.
3. SQL Editor → New query. Paste the whole of `nextjs-app/supabase/migrations/0001_baseline.sql` and run. (It already contains migrations 0002–0007.)
4. New query. Paste the whole of `nextjs-app/supabase/rls-policies.sql` and run (it adds migration 0008). The last three result tables must be empty.
5. Storage: confirm the bucket `source-documents` exists and is **not** public.
6. Database → Replication (or Publications): confirm `ingestion_records` and `review_tasks` are in `supabase_realtime`. If not, run:
   ```sql
   alter publication supabase_realtime add table public.ingestion_records, public.review_tasks;
   ```
7. Optional for a test pilot only: run `nextjs-app/supabase/seed/terminology-sample.sql` so coding works. It is sample data; remove it before real use.

## 4. Supabase sign-in settings
Authentication section of the production project:
1. Sign In / Providers → Email: enabled; **turn off "Allow new users to sign up"**; keep email confirmation on.
2. Password policy: minimum length 12 (and leaked-password protection if shown).
3. Sessions / JWT: JWT expiry 3600 seconds or less; refresh token rotation on.
4. URL Configuration: Site URL and Redirect URLs are set in step 8, after Netlify gives you the address.
5. Project Settings → Database → Backups: enable the best backup option your plan offers.

## 5. Generate the production secrets
Run each in a terminal, three times, and save the outputs in your password manager. These must differ from your local ones, and **must never change once records exist** (changing them breaks patient lookups and source keys).
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
Use outputs for `PATIENT_ID_HMAC_KEY`, `PATIENT_ID_ENC_KEY`, `WORKER_SECRET`. For `SOURCE_KEY_PEPPER` use:
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

## 6. Create the Netlify site
1. app.netlify.com → Add new site → Import an existing project → GitHub → pick `dev-os-personal`.
2. Branch to deploy: `release/mvp-pilot` for the pilot (or `main` after the merge).
3. **Base directory: `nextjs-app`.** Build command `npm run build`. Publish directory `.next` (the Next.js plugin from `netlify.toml` handles the rest).
4. Do not deploy yet if the form allows; add the variables first (step 7). If it deploys and fails, that is fine.
5. Note the site address (for example `https://something.netlify.app`).

## 7. Netlify environment variables
Site configuration → Environment variables. Add each, scope: all (including Functions and Runtime).

| Variable | Value |
|---|---|
| `APP_BASE_URL` | the live address from step 6, with `https://` and no trailing slash |
| `NEXT_PUBLIC_SUPABASE_URL` | production Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | production anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | production service-role key |
| `SUPABASE_STORAGE_BUCKET` | `source-documents` |
| `WORKER_SECRET`, `PATIENT_ID_HMAC_KEY`, `PATIENT_ID_ENC_KEY`, `SOURCE_KEY_PEPPER` | from step 5 |
| `WORKER_HOST_LIMIT_SECONDS` | `26` (Netlify Free web-function limit) |
| `LLM_REQUEST_TIMEOUT_MS` | `20000` |
| `WORKER_TICK_MAX_SECONDS` | `50` |
| `LLM_PROVIDER` | `openai` (or `azure_openai`) |
| `OPENAI_API_KEY` | a **new** key for production, with a spend limit set in the OpenAI dashboard |
| `LLM_MODEL_EXTRACTION` | same as local (`gpt-4.1-mini`) |
| `LLM_PRICE_INPUT_PER_MTOK`, `LLM_PRICE_OUTPUT_PER_MTOK` | same as local |
| `LLM_DAILY_BUDGET_USD` | a small number for the pilot, for example `5` |
| `CONSENT_MODE` | `stub` (the pilot uses the built-in consent ledger) |
| `SYSTEM_AUTOCOMMIT_ENABLED` | `false` |
| `ALERT_WEBHOOK_URL` | optional: a Slack/Teams webhook so alerts reach someone |

Leave unset: `LLM_MODEL_LIGHT`, `EMBEDDINGS_MODEL`, `OCR_PROVIDER` (see the system check warnings; they are expected). Variables set in `netlify.toml` are not seen by functions; set them in the UI only.

## 8. Deploy and finish the Supabase links
1. Netlify → Deploys → Trigger deploy → Deploy site. Wait for "Published". Open the address.
2. Supabase → Authentication → URL Configuration: Site URL = the live address; Redirect URLs = `https://<your-address>/auth/callback` (and `http://localhost:3000/auth/callback` only if you want local sign-in against production, which you should not).

## 9. Create the first organisation and admin
1. Supabase → Authentication → Users → Add user → Create new user: your email and a strong password, tick "Auto Confirm User". Copy the user's UUID.
2. SQL Editor, run (replace the placeholders):
   ```sql
   insert into public.organizations(name) values ('Your organisation name') returning id;
   ```
   Copy the returned id, then:
   ```sql
   insert into public.profiles(id, org_id, email, full_name, role)
   values ('<user-uuid>', '<organisation-id>', lower('<your-email>'), 'Your Name', 'admin');
   ```
3. Open the live address, sign in. You land on the Dashboard.

## 10. Verify
1. Admin → System check. Everything is OK or one of the expected warnings (OCR, embeddings, automatic commit off). "Broken" items name what to fix. Press "Test the model": all checks pass.
2. Sources → create a source, then Admin → Consent (stub) → add a consent for a test patient.
3. Ingest a typed PDF (use the discharge summary). Within about two minutes it reaches "Needs review" with no manual action. If it sits in "Received" for more than 3 minutes: Netlify → Logs & metrics → Functions → `worker-tick`. Scheduled functions run only on the published production deploy.
4. Open the record: fields, dates, codes and the pipeline row agree with the status. As a reviewer approve it; the Audit page shows the chain.
5. Admin → re-run from "Extract fields" on another record; the timeline resets and finishes.
6. Sign out, reopen the site: the sign-in page appears. Enter a wrong password 11 times in a minute: rate-limited.

## 11. If something goes wrong
| Symptom | Look at |
|---|---|
| Record stuck in "Received" | System check "Waiting jobs"; Netlify Functions → `worker-tick` log (each minute it prints the result of a pass, or says why it failed); `WORKER_SECRET` and `APP_BASE_URL` set with Functions scope |
| "Worker time limit" warning or records that stall | Set `WORKER_HOST_LIMIT_SECONDS=26`, `LLM_REQUEST_TIMEOUT_MS=20000`, redeploy once. Netlify Free cuts a web function at about 26 s |
| Sign-in works but pages bounce back to sign-in | Supabase Site URL and Redirect URLs do not match the live address |
| 500 on ingest naming a variable | One of the four secrets in step 5 is missing |
| Anything else | Admin → System check first; then Netlify Functions logs |
