# Spec 01 — Authentication, Roles, Middleware, User Admin [MVP]

## 1. Goal
Authenticate staff of the health data platform, scope every request to one organization and one of four roles, and enforce permissions in API code and in Postgres RLS (defence in depth).

## 2. Auth model
- Supabase Auth email + password and magic link. **Public sign-up disabled** (Dashboard setting; see header of `supabase-schema.sql`). Users exist only if an admin invites them.
- `profiles` row (same id as `auth.users`) holds `org_id`, `role`, `active`. A user with no active profile is treated as unauthenticated (`current_org_id()` returns null → every RLS policy fails closed).
- Session via `@supabase/ssr` cookies. Access token TTL 1 h, refresh via middleware. No tokens in localStorage.
- Brute force: `profiles.failed_logins`, `last_failed_login_at`, `locked_until`. Password sign-in is performed **server-side** by `POST /api/auth/login` so the lock is enforced *before* the password is checked: 5 failures within 15 min set `locked_until = now()+15 min` (atomic SQL function `record_login_failure`); while locked the same generic error is returned and the password is not evaluated; success calls `reset_login_failures`. Responses never reveal whether an email exists or whether an account is locked. (This replaces the earlier client-reported `login-attempt` design, which could not enforce the lock and let a client reset its own counter.)
- `profiles.email` (lower-case, unique) is stored so users can be looked up by email without querying `auth.users`.
- Invited users have no password; they sign in with the email link (`/auth/callback`). A set-password flow is out of MVP scope.
- First admin: bootstrap SQL at bottom of `supabase-schema.sql`.

## 3. Middleware (`src/middleware.ts`)
1. Refresh session (`updateSession`).
2. Public paths: `/login`, `/api/health`, `/_next/*`, `/favicon.ico`, `/api/worker/*` and `/api/internal/*` (those authenticate by secret header, not session), `/api/ingestions` when header `X-Source-Key` present (handler validates).
3. No session → redirect to `/login?next=<path>` (pages) or `401 UNAUTHENTICATED` (API).
4. Role route guard map (pages):

| Path prefix | Allowed roles |
|---|---|
| `/ingest` | integration_engineer, admin |
| `/records` | integration_engineer, reviewer, admin |
| `/review` | reviewer, admin |
| `/sources`, `/settings/thresholds` | integration_engineer, admin |
| `/dashboard` | all |
| `/audit`, `/admin` | admin |

Role is read from `profiles` on every page request using the user's own session (RLS applies); there is no cached role cookie, so role changes and deactivation apply immediately. API routes re-read the profile on every call. Disallowed → redirect to the role's home: reviewer `/review`, integration_engineer `/ingest`, admin `/audit`, viewer `/dashboard`.

## 4. `route()` wrapper and `withAuth` (`src/lib/auth/withAuth.ts`)
```ts
export async function requireUser(req): Promise<{ userId: string; orgId: string; role: Role }>
// throws AppError('UNAUTHENTICATED') if no session or inactive profile
export function requireRole(user, roles: Role[]) // throws AppError('FORBIDDEN')
```
Every non-public handler calls `requireUser` then `requireRole`. IDOR rule: every handler that loads by id re-checks `org_id` (RLS does it for the user client; service-role code must add `.eq('org_id', user.orgId)`).

## 5. API

| Method/Path | Auth | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/me` | any | — | `{id, email, full_name, role, org_id, org_name}` | 401 |
| `POST /api/auth/login` | public (10/min/IP) | `{email, password}` | `200 {role, redirect_to}` and session cookies | 401 generic, 422, 429 |
| `POST /api/auth/magic-link` | public (5/min/IP) | `{email}` | `202 {sent:true}` always | 422, 429 |
| `GET /auth/callback` | public | `?code&next` | redirect (role home or sanitized `next`) | `/login?error=link_invalid|no_access` |
| `GET /api/admin/users` | admin | `?limit&cursor` | `{data:[{id,email,full_name,role,active,last_sign_in_at}]}` | |
| `POST /api/admin/users` | admin | `{email, full_name(1..120), role}` | `201 {id}`; sends Supabase invite email | 409 if email exists; 422 |
| `PATCH /api/admin/users/:id` | admin | `{role?, active?, full_name?}` | `200` | 409 `LAST_ADMIN` if it would leave zero active admins; cannot modify self-role |

`POST /api/admin/users` uses `supabaseAdmin.auth.admin.inviteUserByEmail(email)` then inserts the `profiles` row with the caller's `org_id`. If the profile insert fails the auth user is deleted (compensation). Audit: `user.created`, `user.role_changed`.

## 6. UI
- `/login`: email, password, "Email me a sign-in link". States: idle, submitting (button disabled), error (generic "Invalid email or password"; locked → "Too many attempts. Try again in 15 minutes."). `autocomplete` attributes set; paste allowed.
- `/admin/users`: table (name, email, role select, active toggle), "Invite user" dialog. Role change and deactivation use `ConfirmDialog`. Own row's role/active controls disabled.
- Topbar user menu: name, role badge, sign out (`supabase.auth.signOut()` then `/login`).

## 7. RLS
Implemented in `supabase-schema.sql` §13. Helper functions: `current_org_id()`, `current_app_role()`, `has_role(variadic role_t[])`, `record_in_my_org()`, `source_in_my_org()`. Writes by non-service clients exist only for `provider_sources` and `routing_thresholds` (IE/admin) and `profiles` (admin). Everything else is written by service-role code after explicit authz.

## 8. Edge cases
- Deactivated user with a live session: next request fails because `current_app_role()` is null; `requireUser` throws 401 and the client signs out.
- Role changed mid-session: takes effect on next request (role is never read from JWT claims).
- Two admins demote each other concurrently: the `LAST_ADMIN` check runs in a transaction using `select … for update` on active admin profiles.
- Magic-link for non-invited email: Supabase `shouldCreateUser:false` so no account is created; UI shows the same generic confirmation.
- Cross-org access via guessed UUID returns 404, not 403.

## 9. Acceptance criteria
1. A viewer's direct Supabase query on `ingestion_records`, `fhir_resources`, `documents` returns zero rows.
2. A reviewer calling `POST /api/sources` receives 403.
3. User from org A cannot read any row of org B through the API or direct Supabase client.
4. Five wrong passwords lock the account; the sixth attempt with the correct password is still rejected until the lock expires.
5. Demoting or deactivating the last active admin returns 409 `LAST_ADMIN`.
6. A deactivated user is rejected on the next API call.
7. `auth.login`, `user.created`, `user.role_changed` appear in `audit_log`.
