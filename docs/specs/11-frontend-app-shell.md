# Spec 11 — Frontend App Shell, Shared Components and Page Contracts [MVP]

## 1. Goal
Define the Next.js 14 frontend foundation shared by all features: layout, navigation, design-system usage, data-fetching conventions, real-time updates, UX states and accessibility. Feature pages are specified in their own specs (03, 09, 10, 13, 02, 01).

## 2. Stack (fixed)
Next.js 14 App Router · TypeScript strict · Tailwind CSS · shadcn/ui (Radix) · TanStack Query v5 · Zustand (review workspace only) · React Hook Form + Zod · TanStack Table · Recharts · `react-pdf`/pdf.js · `@supabase/ssr` + `@supabase/supabase-js`.
**Design system:** every color, spacing, radius, typography and component style comes from `docs/design.md` via the `/design-system` skill. No hard-coded hex values or ad-hoc font sizes in components; use Tailwind theme tokens generated from the design system into `tailwind.config.ts` (`theme.extend.colors`, `fontFamily`, `spacing`, `borderRadius`) and CSS variables in `globals.css`. Light and dark themes must both be supported if the design system defines them. (Stage 3 must create `docs/design.md` tokens → Tailwind mapping before any component is written.)

## 3. App shell
`src/app/(app)/layout.tsx` (server component):
1. Gets session + profile via server Supabase client; redirects to `/login` if absent.
2. Renders `AppShell`: left `Sidebar`, top `Topbar`, `<main id="main">` with skip-link target.
3. Provides `QueryProvider`, `ToastProvider`, `RoleProvider` (`useRole()`).

**Sidebar items** (role-filtered): Ingest (`/ingest`), Records (`/records`), Review queue (`/review`, badge = open tasks count for reviewer/admin via Realtime), Sources (`/sources`), Dashboard (`/dashboard`), Audit (`/audit`), Users (`/admin/users`), Consent (stub mode, `/admin/consent`). Active state by `usePathname`. Collapsible; persisted in `localStorage` (try/catch).
**Topbar:** breadcrumb, global banner slot (`SystemBanner`: consent service degraded, source paused count, audit integrity failure), user menu (role badge, sign out), theme toggle if design system has dark mode.

## 4. Shared components (`src/components/shared`, `ui`)
| Component | Props / behavior |
|---|---|
| `StatusBadge` | `status: RecordStatus` → label + icon + token color; mapping: received/…processing = neutral "Processing (stage)"; `needs_review`/`in_review` = warning; `blocked_consent` = danger; `auto_committed`/`committed` = success; `rejected`/`failed` = danger. Always text + icon |
| `ConfidenceBar` | `score`, `threshold?`, `size`; numeric label; threshold tick; `role="meter"` with aria values |
| `BasisChip` | Stated / Inferred |
| `AiExtractedTag` | text "AI-extracted" with tooltip describing method; shown on all committed values |
| `ConfirmDialog` | title, body, `requireReason?: {min:number}`; focus trap; destructive variant |
| `EmptyState`, `ErrorState` (shows `request_id`), `Skeleton*` | per-view loading skeletons |
| `DataTable` | TanStack Table wrapper: sorting, cursor pagination, column visibility, empty/error/loading states, keyboard row navigation |
| `RoleGate` | `<RoleGate allow={[...]}>children</RoleGate>` hides UI by role (server still enforces) |
| `CopyField` | masked secret copy button (API key modal) |
| `PageHeader` | title, description, actions |

## 5. Data fetching conventions
- Query keys in `src/lib/api/queryKeys.ts` (`['records', filters]`, `['record', id]`, `['review-queue', filters]`, …).
- Fetch wrapper `apiFetch<T>(path, init)` parses envelope, throws `ApiError {code, message, requestId, details}`; 401 → `signOut` + redirect `/login`.
- Mutations invalidate affected keys; optimistic updates only for toggles (never for commits/decisions).
- Realtime hooks (`useRealtimeRecords(orgId)`, `useRealtimeReviewTasks()`): subscribe to `postgres_changes` on `ingestion_records` / `review_tasks`; on event update the TanStack cache; on channel error/close start polling every 10 s and show a "Reconnecting…" chip; cleanup on unmount. RLS applies to Realtime so users only receive permitted rows.
- Server components fetch read-heavy pages (records list first page, source list, dashboard) with the user-scoped Supabase client; client components handle interaction.
- No PHI in `localStorage`/`sessionStorage` except the review draft decisions (spec 09) which hold field keys/values for the open task only and are cleared on completion.

## 6. UX state rules (every data view)
| State | Requirement |
|---|---|
| Loading | Skeleton with final layout, no layout shift; buttons show spinner and are disabled during mutation |
| Empty | Message + primary action ("No records yet — Submit one") |
| Error | `ErrorState` with retry and `request_id`; 403 → "You don't have access to this page"; never raw errors |
| Partial/stale | "Updated <time>" label on dashboards; Realtime reconnect chip |
| Forms | Inline Zod errors under fields, focus first invalid field, `aria-describedby` |
| Destructive/safety actions | `ConfirmDialog` with reason where specified (pause, resume, thresholds, key rotation) |
| Responsive | Breakpoints from design system; review workspace ≥ 1280 three-pane, 1024–1279 two-pane, < 1024 tabs; tables scroll horizontally inside container; no page-level horizontal scroll at 375 px for non-review pages |
| Accessibility | WCAG 2.1 AA: visible focus, keyboard operability, semantic landmarks, `aria-live="polite"` for status updates, color never the sole indicator, reduced-motion respected, 4.5:1 contrast via tokens, tested with axe |
| i18n | English UI only; strings in `src/lib/strings.ts` to ease later localization |

## 7. Pages and route files (all under `src/app/(app)` unless noted)

| Route | File | Spec | Data |
|---|---|---|---|
| `/login` | `(auth)/login/page.tsx` | 01 | Supabase Auth |
| `/ingest` | `ingest/page.tsx` | 03 | `GET /api/sources`, `POST /api/ingestions`, Realtime |
| `/records` | `records/page.tsx` | 03/10 | `GET /api/ingestions` |
| `/records/[id]` | `records/[id]/page.tsx` | 03,06,07,08,10 | `GET /api/ingestions/:id` |
| `/review` | `review/page.tsx` | 09 | `GET /api/review-tasks` |
| `/review/[taskId]` | `review/[taskId]/page.tsx` | 09 | `GET /api/review-tasks/:id` |
| `/sources`, `/sources/new`, `/sources/[id]` | `sources/…` | 02 | sources APIs |
| `/settings/thresholds` | `settings/thresholds/page.tsx` | 02 | matrix across sources |
| `/dashboard` | `dashboard/page.tsx` | 13 | metrics APIs |
| `/audit` | `audit/page.tsx` | 10 | audit APIs |
| `/admin/users` | `admin/users/page.tsx` | 01 | user APIs |
| `/admin/consent` | `admin/consent/page.tsx` | 05 | stub consent APIs |

`/records/[id]` layout: header (status, source, doc type, time, cost, latency), **PipelineTimeline** (8 stage nodes with state, duration, link to audit event), tabs **Fields** (table w/ citations), **FHIR** (resource cards + raw JSON), **Decision** (routing summary), **Consent**, **Provenance**, **Source** (document viewer; hidden for blocked consent), actions (Retry for allowed states, Report downstream error for admin/reviewer).

## 8. Edge cases
- Session expires while on review workspace: draft decisions preserved in sessionStorage; user re-authenticates and returns via `next` param.
- Realtime event for a record the user can't see: never delivered (RLS).
- Two tabs: Zustand state per task keyed by task id; second tab shows "task open elsewhere" if lock heartbeat belongs to another session id (`localStorage` lock key with try/catch).
- JS disabled: server-rendered pages show read-only data; actions require JS (acceptable).
- Very long values (> 500 chars) truncated with "Show more"; never rendered as HTML.
- Dark mode: PDF page images keep original colors; overlays use tokens.

## 9. Acceptance criteria
1. A viewer sees only Dashboard in the sidebar; direct navigation to `/records` redirects to `/dashboard`.
2. All list pages show skeleton → data / empty / error states (Storybook or Playwright states verified).
3. Statuses never rely on color alone (axe + manual check); axe reports 0 serious/critical violations on login, ingest, records, review, dashboard, audit.
4. Realtime status change appears on `/ingest` without reload within 2 s; if the websocket is blocked the page updates within 10 s via polling.
5. No hex literals or px font sizes appear in component files (lint rule `no-restricted-syntax` + grep check in CI).
6. Layout verified at 375, 768, 1280 widths for non-review pages; review workspace at 1280 and 1024.
