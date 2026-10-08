# dev-os

A structured AI-assisted development operating system for building production-ready apps — from idea to deployed product using a stage-gated workflow enforced through Claude Code skills.

---

## What This Is

`dev-os` is a Claude Code project that provides a repeatable, stage-by-stage workflow for building full-stack web applications. Each stage has a dedicated skill that Claude runs when invoked. No stage begins until the previous one is approved.

The current application target is **ContractIQ** — an enterprise AI contract review platform for NDA and MSA analysis.

---

## Folder Structure

```
dev-os/
├── CLAUDE.md                     # Project instructions & stage-gated workflow rules
├── docs/
│   ├── design.md                 # Brand design system (colors, typography, spacing, components)
│   ├── ContractIQ_PRD.md         # Product Requirements Document for ContractIQ
├── skills/                       # Claude Code custom skills (slash commands)
│   ├── engineering-planner/
│   │   └── SKILL.md              # Stage 1: PRD → engineering docs
│   ├── implementation-specs/
│   │   └── SKILL.md              # Stage 2: Engineering docs → granular specs + SQL
│   ├── security-foundation/
│   │   └── SKILL.md              # Stage 3: Specs → security controls + RLS policies
│   ├── frontend-setup/
│   │   └── SKILL.md              # Stage 4: Scaffold Next.js 14 App Router project
│   └── design-system/
│       └── SKILL.md              # Applied during all frontend work — enforces design.md
```

> Files and folders under `docs/engineering/`, `docs/specs/`, `docs/security/`, and `.env.example` are generated outputs — they are created during the build workflow and do not exist until their respective stage runs.

---

## The Build Workflow

Each stage must be completed and approved before the next begins.

| Stage | Skill | Input | Output |
|---|---|---|---|
| 1 — Engineering Plan | `/engineering-planner` | PRD | `docs/engineering/engineering-doc.md` + `docs/engineering/implementation-specs.md` |
| 2 — Implementation Specs | `/implementation-specs` | Stage 1 docs | `docs/specs/*.md` + `docs/specs/supabase-schema.sql` + `.env.example` |
| 3 — Security Foundation | `/security-foundation` | Stages 1–2 docs | `docs/security/security-plan.md` + `supabase/rls-policies.sql` + `src/lib/security/` |
| 4 — Frontend Setup | `/frontend-setup` | Stages 2–3 docs | Scaffolded Next.js 14 app |
| 5 — Feature Implementation | *(manual, one feature at a time)* | `docs/specs/*.md` | Feature code |

---

## Skills

Skills live in `skills/<name>/SKILL.md` and are invoked as slash commands in Claude Code.

### `/engineering-planner`
Transforms a PRD into two engineering documents. Asks clarifying questions (auth strategy, DB, LLM provider, user roles) before generating anything. Output is the authoritative reference for all downstream stages.

### `/implementation-specs`
Reads the approved engineering docs and generates granular, runnable specs — one file per concern. Always produces `supabase-schema.sql` (paste-and-run SQL) and `.env.example` (all environment variables grouped by service).

### `/security-foundation`
Reviews all engineering and spec documents, identifies every security surface, and implements controls before any feature code is written. Covers auth, rate limiting, prompt injection, token limits, file upload validation, RLS policies, and environment variable protection.

### `/frontend-setup`
Scaffolds a complete Next.js 14 (App Router) project — `package.json`, `next.config.mjs`, `app/layout.jsx`, `app/globals.css`, `app/page.jsx` — and runs the dev server.

### `/design-system`
Enforces the brand design system defined in `docs/design.md` on all frontend code. Applied automatically whenever any UI component, page, or style is written. Uses Inter for body text, JetBrains Mono for contract content, and `#112E81` as the primary brand color.

---

## Key Rules

- **Never skip a stage.** Each stage depends on the output of the previous one.
- **Never proceed without user approval.** Claude stops after every stage and waits.
- **Never write code before specs exist.** Implementation only starts after Stage 2 is approved.
- **Always apply the design system** when writing any frontend code.

---

## Current Project: ContractIQ

An enterprise AI platform for legal contract review, targeting NDA and MSA documents. The PRD is at `docs/ContractIQ_PRD.md`.

Tech stack (fixed):
- **Frontend:** Next.js 14 (App Router)
- **Backend:** Next.js API Routes
- **Database:** Supabase (PostgreSQL + Auth + Storage)
- **AI:** OpenAI API (or Azure OpenAI for in-region data)
- **UI:** Lucide React icons, Inter + JetBrains Mono fonts