# Security plan — Trust at the Edge

Scan date 2026-10-08. The security skill (`skills/security-foundation`) was written for a contract-chat app, so its items were mapped to this app: there is no chat or contract upload here; the equivalents are the record pipeline, the model calls and document ingestion. Code paths are relative to `nextjs-app/`.

## Controls already in place (verified, not changed)
| Area | Control | Where |
|---|---|---|
| Authentication | Supabase email + password and email link; active profile required on every request; role read from `profiles`, never from the token; lock-out after repeated failures; generic "invalid credentials" answer | `src/lib/auth/withAuth.ts`, `src/server/services/auth/authService.ts` |
| Protected pages | Middleware sends signed-out users to `/login?next=`; per-role page access | `src/middleware.ts`, `src/lib/auth/pageAccess.ts` |
| Open redirect | `next` is only followed when it is a path inside the app | `src/lib/auth/safeRedirect.ts` |
| Request validation | Every route runs through `route()`: authentication, role, rate limit, Zod body and query, error mapping (422 on invalid input). A test fails if a route is missing from the authorization matrix | `src/lib/api/route.ts`, `tests/integration/apiAuthz.matrix.test.ts` |
| Uploads | File type from content (magic bytes), never from name or declared type; size limit checked before reading; binary rejected as text; files only in a private bucket; signed links expire | `src/server/services/ingestion/detectInput.ts`, `parseSubmission.ts` |
| Model safety | Every extracted value must quote the document; instructions inside documents are flagged (`extraction.injection_suspected`) and never change a score; the model chooses only among offered code candidates; daily spend cap, circuit breaker, kill switch | `src/server/services/extraction/grounding.ts`, `src/server/services/safety/` |
| Secrets | Service-role key referenced only in `src/lib/supabase/admin.ts` (server-only); only the Supabase URL and anon key are public; logger redacts sensitive keys; production bundle is scanned for secret names and values (`npm run check:bundle`) | `src/lib/supabase/admin.ts`, `src/server/logger.ts`, `scripts/check-bundle-secrets.mjs` |
| Internal endpoints | Worker secret compared in constant time; fails closed when unset | `src/server/worker/auth.ts` |
| Audit | Append-only audit log with hash chain and verification | migrations 0001, 0003 |
| Dependencies | Next.js 14.2.35 | `package.json` |

## Issues found and fixed in this pass
| # | Issue | Risk | Fix |
|---|---|---|---|
| 1 | Rate limit was counted in memory per server instance | On serverless hosting an attacker could spread sign-in guesses over instances and avoid the limit | Database-backed sliding window (`rate_limit_events`, `rate_limit_hit`, migration `0008_rate_limit.sql`). Used for every route with its own limit (sign-in, email link, logout, exports, admin model test) and for source-key feeds. The in-memory limit still runs first; if the database is unreachable the request is let through and a warning is logged |
| 2 | No security headers | Clickjacking, content sniffing, no transport enforcement | `next.config.mjs`: Content-Security-Policy (scripts, connections and forms limited to this site and Supabase; no framing; no plugins), X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, Cross-Origin-Opener-Policy, and HSTS in production |
| 3 | Session cookies had no Secure flag and a 400-day life | Cookie could travel over plain HTTP; sessions outlived the browser | `src/lib/supabase/sessionCookies.ts`: Secure in production, session-only |
| 4 | No cross-site request check | A page on another site could trigger actions with a user's cookies where SameSite does not apply | `assertSameOrigin` in `route()` and the ingestion route: a browser POST/PATCH/PUT/DELETE whose `Origin` is not this app is refused (403 `CROSS_SITE`). Callers using a Bearer token, source key or worker secret are unaffected |
| 5 | Client address taken from `x-forwarded-for` | A client can write that header, so per-address limits could be evaded | `clientIp` prefers the hosting provider's header (`x-nf-client-connection-ip`), then `x-real-ip` |
| 6 | Sign-out ran only in the browser | Cookies not cleared with the right attributes; no audit entry | `POST /api/auth/logout` clears the session on the server and writes `auth.logout`; the app's sign-out uses it |
| 7 | RLS only enabled by the baseline migration | A table added later could be left open | `supabase/rls-policies.sql` enables RLS on every public table (idempotent) and ends with queries that list open tables, functions callable by users and public buckets |
| 8 | Misconfiguration was invisible | A missing migration or secret showed up as a runtime failure | `/admin/system` self-check now also verifies `rate_limit_hit` |

## SQL to run in Supabase (SQL Editor)
1. `supabase/migrations/0008_rate_limit.sql` (or `supabase/rls-policies.sql`, which includes it).
2. `supabase/rls-policies.sql`. Its last three queries must return no rows.

## Settings to check in the Supabase dashboard (cannot be changed from code)
- Authentication → Providers → Email: **disable "Allow new users to sign up"** (this app is invite-only), confirm email is required.
- Authentication → Password: minimum length 12; enable leaked-password protection if the plan offers it.
- Authentication → Sessions: refresh token rotation on; set a JWT expiry of 1 hour or less; set an inactivity timeout if available.
- Authentication → URL configuration: site URL and redirect URLs list only the production address (and localhost for development).
- Authentication → Rate limits: keep the defaults for emails and sign-ins.
- Storage: the `source-documents` bucket is private.
- Database → Backups: point-in-time recovery on.

## Not applicable to this app
- Contract and chat ownership checks, chat history limits, and the `/contracts`, `/chat` routes: the app has no chat. The equivalent ownership rule (every record read is scoped to the caller's organisation through RLS and an `org_id` filter) is covered by the authorization matrix.
- A page-count and file-size limit for documents exists in the ingestion limits (`OCR_MAX_PAGES`, upload size limit in `parseSubmission.ts`).
- Prompt-injection blocking by phrase list: the app does not block documents that contain such phrases (a real discharge summary may), it flags them and guarantees by design that text in a document cannot change codes, scores or routing.

## Outstanding
| Item | Why it is open |
|---|---|
| Two PostCSS advisories inside Next.js | Fixed only in Next 16; build-time only, not reachable from user input. Plan the upgrade |
| CSP allows inline scripts | Next.js 14 needs them unless nonces are used. Moving to nonces is a larger change; the other directives still block outside scripts and framing |
| Rate-limit window is per minute | Fine for sign-in; a daily upload quota would need a separate counter |
| Penetration test | Recommended before real patient data |
| `tests/sql/acceptance.sql` not yet run | Needs to be run against the database by the owner |
