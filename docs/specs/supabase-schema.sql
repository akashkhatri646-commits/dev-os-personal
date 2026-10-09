-- =====================================================================
-- Agentic Health Record Ingestion — Supabase schema
-- Paste into Supabase SQL Editor on a FRESH project and run once.
-- Source of truth: docs/engineering/engineering-doc.md §7
-- Pre-reqs (Dashboard): Auth > Providers > Email: disable "Allow new users to sign up"
--                       (users are invited by admins via the service role only).
-- =====================================================================

-- ---------- 1. Extensions -------------------------------------------
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector   with schema extensions;
create extension if not exists pg_trgm  with schema extensions;

-- ---------- 2. Enums -------------------------------------------------
create type role_t            as enum ('integration_engineer','reviewer','admin','viewer');
create type regime_t          as enum ('abdm','hipaa');
create type doc_t             as enum ('discharge_summary','lab_report','other');
create type input_t           as enum ('pdf','image','hl7v2','text');
create type record_status_t   as enum (
  'received','consent_check','blocked_consent','normalizing','extracting','mapping',
  'validating','scoring','routing','needs_review','in_review','auto_committed',
  'committed','rejected','failed');
create type consent_result_t  as enum ('valid','missing','expired','revoked','out_of_scope','error');
create type consent_status_t  as enum ('granted','revoked','expired');
create type basis_t           as enum ('stated','inferred');
create type validation_t      as enum ('pending','pass','fail');
create type score_scope_t     as enum ('field','resource','record');
create type decision_t        as enum ('auto_commit','escalate');
create type review_status_t   as enum ('open','claimed','completed','released');
create type review_kind_t     as enum ('escalation','holdback_audit','downstream_error_review');
create type review_action_t   as enum ('accept','correct','reject');
create type commit_mode_t     as enum ('auto','human');
create type actor_t           as enum ('user','system','api_key');
create type job_stage_t       as enum ('consent_check','normalize','extract','map','validate','score','route','commit');
create type job_status_t      as enum ('queued','running','done','failed','dead');
create type prompt_component_t as enum ('extraction','mapping','scoring','routing_explain');
create type terminology_sys_t as enum ('snomed','loinc','icd10');
create type eval_origin_t     as enum ('clinician','synthetic','public','production_correction');
create type eval_split_t      as enum ('dev','heldout');
create type eval_status_t     as enum ('none','passed','failed');
create type proposal_status_t as enum ('pending','approved','rejected');
create type error_status_t    as enum ('open','investigating','resolved');
create type size_class_t      as enum ('small','medium','large');

-- ---------- 3. Generic helper functions -----------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ---------- 4. Tables (dependency order) -----------------------------
create table public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  region     text not null default 'in',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  org_id     uuid not null references public.organizations(id),
  email      text not null,
  full_name  text,
  role       role_t not null,
  active     boolean not null default true,
  failed_logins int not null default 0,
  last_failed_login_at timestamptz,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_profiles_org_role on public.profiles(org_id, role);
create unique index uq_profiles_email on public.profiles(lower(email));
alter table public.profiles add constraint chk_profiles_email_lower check (email = lower(email));

-- RLS helper functions (SECURITY DEFINER so policies don't recurse into profiles RLS)
create or replace function public.current_org_id() returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from public.profiles where id = auth.uid() and active
$$;

create or replace function public.current_app_role() returns role_t
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create or replace function public.has_role(variadic roles role_t[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.current_app_role() = any(roles), false)
$$;

create table public.provider_sources (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations(id),
  name                 text not null,
  provider_type        text not null check (provider_type in ('hospital','lab','clinic')),
  size_class           size_class_t not null,
  region               text,
  primary_language     text not null default 'en',
  doc_types            doc_t[] not null default array['discharge_summary']::doc_t[],
  consent_regime       regime_t not null default 'abdm',
  auto_commit_enabled  boolean not null default false,
  pause_reason         text,
  eval_status          eval_status_t not null default 'none',
  eval_passed_at       timestamptz,
  eval_basis           text check (eval_basis in ('synthetic','real')),   -- migration 0010
  holdback_pct         numeric(5,2) not null default 10 check (holdback_pct between 0 and 100),
  flagged_poor         boolean not null default false,
  created_by           uuid references public.profiles(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, name),
  -- auto-commit can only be on if eval passed
  constraint chk_source_autocommit_requires_eval
    check (not auto_commit_enabled or eval_status = 'passed')
);
create index idx_provider_sources_org on public.provider_sources(org_id);

-- API keys for feed ingestion: service-role only (RLS on, no policies)
create table public.source_api_keys (
  id         uuid primary key default gen_random_uuid(),
  source_id  uuid not null references public.provider_sources(id) on delete cascade,
  key_prefix text not null,
  key_hash   text not null unique,      -- sha256 hex of full key
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index idx_source_api_keys_source on public.source_api_keys(source_id) where revoked_at is null;

create table public.patients (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id),
  source_id     uuid not null references public.provider_sources(id),
  abha_enc      bytea,                 -- app-layer AES-GCM ciphertext
  abha_hash     text,                  -- HMAC-SHA256(PATIENT_ID_HMAC_KEY, normalized abha)
  mrn_enc       bytea,
  mrn_hash      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint chk_patient_has_identifier check (abha_hash is not null or mrn_hash is not null)
);
create unique index uq_patients_org_abha on public.patients(org_id, abha_hash) where abha_hash is not null;
create unique index uq_patients_source_mrn on public.patients(source_id, mrn_hash) where mrn_hash is not null;

create table public.consent_artifacts (
  id          uuid primary key default gen_random_uuid(),
  patient_id  uuid not null references public.patients(id),
  artifact_ref text not null,
  regime      regime_t not null default 'abdm',
  categories  text[] not null,
  valid_from  timestamptz not null,
  valid_to    timestamptz not null,
  status      consent_status_t not null default 'granted',
  hip_id      text,
  raw         jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (regime, artifact_ref),
  check (valid_to > valid_from)
);
create index idx_consent_artifacts_patient on public.consent_artifacts(patient_id, status, valid_to);

create table public.eval_runs (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id),
  kind       text not null check (kind in ('extraction','mapping','calibration','consent','end_to_end','source_onboarding')),
  source_id  uuid references public.provider_sources(id),
  prompt_set jsonb not null default '{}',
  metrics    jsonb not null default '{}',
  passed     boolean not null,
  sample_count int not null default 0,
  basis      text check (basis in ('synthetic','real')),   -- migration 0010
  ran_at     timestamptz not null default now()
);
create index idx_eval_runs_kind on public.eval_runs(org_id, kind, ran_at desc);

create table public.prompt_versions (
  id          uuid primary key default gen_random_uuid(),
  component   prompt_component_t not null,
  version     text not null,
  template    text not null,
  few_shot    jsonb not null default '[]',
  model_id    text not null,
  eval_run_id uuid references public.eval_runs(id),
  active      boolean not null default false,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (component, version)
);
create unique index uq_prompt_versions_one_active on public.prompt_versions(component) where active;

create table public.ingestion_records (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id),
  source_id        uuid not null references public.provider_sources(id),
  patient_id       uuid references public.patients(id),
  doc_type         doc_t not null,
  input_kind       input_t not null,
  data_categories  text[] not null,
  status           record_status_t not null default 'received',
  status_reason    text,
  content_sha256   text not null,
  idempotency_key  text,
  submitted_by     uuid references public.profiles(id),
  holdback         boolean not null default false,
  prompt_set       jsonb not null default '{}',   -- {"extraction":"<uuid>", "model_id":"..."}
  cost_usd         numeric(10,4) not null default 0,
  latency_ms       integer,
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (cardinality(data_categories) > 0)
);
-- blocked_consent records must not prevent re-submission once consent is fixed
create unique index uq_ingestion_content on public.ingestion_records(source_id, content_sha256)
  where status <> 'blocked_consent';
create unique index uq_ingestion_idem on public.ingestion_records(source_id, idempotency_key) where idempotency_key is not null;
create index idx_ingestion_records_org_status on public.ingestion_records(org_id, status, created_at desc);
create index idx_ingestion_records_source on public.ingestion_records(source_id, created_at desc);

create table public.documents (
  id             uuid primary key default gen_random_uuid(),
  record_id      uuid not null references public.ingestion_records(id) on delete cascade,
  storage_path   text not null,
  mime_type      text not null,
  bytes          integer not null check (bytes > 0),
  page_count     integer,
  ocr_engine     text,
  ocr_confidence numeric(4,3) check (ocr_confidence between 0 and 1),
  normalized_text jsonb,          -- [{page, text, blocks:[{id,bbox,text,conf}]}]
  created_at     timestamptz not null default now()
);
create index idx_documents_record on public.documents(record_id);

create table public.consent_checks (
  id                uuid primary key default gen_random_uuid(),
  record_id         uuid not null unique references public.ingestion_records(id) on delete cascade,
  result            consent_result_t not null,
  artifact_id       uuid references public.consent_artifacts(id),
  required_categories text[] not null,
  matched_scope     text[] not null default '{}',
  regime            regime_t not null,
  detail            jsonb,
  checked_at        timestamptz not null default now()
);

create table public.extracted_fields (
  id               uuid primary key default gen_random_uuid(),
  record_id        uuid not null references public.ingestion_records(id) on delete cascade,
  field_key        text not null,
  resource_type    text not null,
  value            jsonb,
  found            boolean not null,
  source_page      integer,
  source_span      jsonb,           -- {block_ids:[], quote:"", char_start:int, char_end:int, bbox:[x0,y0,x1,y1]}
  grounded         boolean not null default false,
  basis            basis_t,
  model_confidence numeric(4,3) check (model_confidence between 0 and 1),
  prompt_version_id uuid references public.prompt_versions(id),
  created_at       timestamptz not null default now(),
  unique (record_id, field_key),
  constraint chk_found_has_span check (not found or source_span is not null)
);
create index idx_extracted_fields_record on public.extracted_fields(record_id);

create table public.mapped_resources (
  id               uuid primary key default gen_random_uuid(),
  record_id        uuid not null references public.ingestion_records(id) on delete cascade,
  resource_type    text not null,
  resource         jsonb not null,
  codings          jsonb not null default '[]',   -- [{field_key,system,code,display,match_confidence,candidates:[]}]
  validation_status validation_t not null default 'pending',
  validation_issues jsonb not null default '[]',
  flags            text[] not null default '{}',   -- risk flags: uncoded, range_value, unit_unmapped, ...
  source_ref       text,                           -- entity the resource was built from, e.g. medication[0]
  profile_url      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index idx_mapped_resources_record on public.mapped_resources(record_id, resource_type);

create table public.field_scores (
  id                 uuid primary key default gen_random_uuid(),
  record_id          uuid not null references public.ingestion_records(id) on delete cascade,
  scope              score_scope_t not null,
  field_key          text,
  resource_id        uuid references public.mapped_resources(id) on delete cascade,
  extraction_conf    numeric(4,3),
  mapping_conf       numeric(4,3),
  validation_completeness numeric(4,3),
  score              numeric(4,3) not null check (score between 0 and 1),
  components         jsonb not null default '{}',
  reasoning          text,
  created_at         timestamptz not null default now()
);
create index idx_field_scores_record on public.field_scores(record_id, scope);

create table public.routing_thresholds (
  id            uuid primary key default gen_random_uuid(),
  source_id     uuid not null references public.provider_sources(id) on delete cascade,
  resource_type text not null default '*',
  threshold     numeric(4,3) not null check (threshold between 0.5 and 0.999),
  version       integer not null,
  active        boolean not null default true,
  changed_by    uuid references public.profiles(id),
  reason        text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (source_id, resource_type, version)
);
create unique index uq_routing_thresholds_active on public.routing_thresholds(source_id, resource_type) where active;

create table public.routing_decisions (
  id                uuid primary key default gen_random_uuid(),
  record_id         uuid not null unique references public.ingestion_records(id) on delete cascade,
  aggregate_score   numeric(4,3) not null,
  thresholds_applied jsonb not null,
  validation_result validation_t not null,
  decision          decision_t not null,
  escalation_reasons text[] not null default '{}',
  reasoning_trace   text not null,
  rule_version      text not null,
  created_at        timestamptz not null default now()
);

create table public.review_tasks (
  id              uuid primary key default gen_random_uuid(),
  record_id       uuid not null references public.ingestion_records(id) on delete cascade,
  status          review_status_t not null default 'open',
  kind            review_kind_t not null default 'escalation',
  priority        numeric(6,3) not null default 0,
  claimed_by      uuid references public.profiles(id),
  claimed_at      timestamptz,
  lock_expires_at timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index idx_review_tasks_queue on public.review_tasks(status, priority desc, created_at);
create unique index uq_review_tasks_one_open on public.review_tasks(record_id, kind) where status in ('open','claimed');

create table public.review_corrections (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid not null references public.review_tasks(id) on delete cascade,
  record_id       uuid not null references public.ingestion_records(id) on delete cascade,
  source_id       uuid not null references public.provider_sources(id),
  field_key       text not null,
  action          review_action_t not null,
  original_value  jsonb,
  corrected_value jsonb,
  original_code   jsonb,
  corrected_code  jsonb,
  source_span     jsonb,
  note            text,
  reviewer_id     uuid not null references public.profiles(id),
  reviewed_at     timestamptz not null default now(),
  unique (task_id, field_key)
);
create index idx_review_corrections_source on public.review_corrections(source_id, reviewed_at);

create table public.fhir_resources (
  id            uuid primary key,                 -- also the FHIR logical id
  org_id        uuid not null references public.organizations(id),
  record_id     uuid not null references public.ingestion_records(id),
  patient_id    uuid not null references public.patients(id),
  resource_type text not null,
  resource      jsonb not null,
  version_id    integer not null default 1,
  commit_mode   commit_mode_t not null,
  ai_extracted  boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint chk_fhir_type_matches check (resource->>'resourceType' = resource_type)
);
create index idx_fhir_resources_patient on public.fhir_resources(patient_id, resource_type);
create index idx_fhir_resources_record on public.fhir_resources(record_id);
create index idx_fhir_resources_gin on public.fhir_resources using gin (resource jsonb_path_ops);

create table public.fhir_resource_versions (
  id              bigserial primary key,
  fhir_resource_id uuid not null,
  version_id      integer not null,
  resource        jsonb not null,
  archived_at     timestamptz not null default now()
);
create index idx_fhir_resource_versions on public.fhir_resource_versions(fhir_resource_id, version_id);

create table public.provenance (
  id                 uuid primary key default gen_random_uuid(),
  fhir_resource_id   uuid not null unique references public.fhir_resources(id),
  record_id          uuid not null references public.ingestion_records(id),
  source_id          uuid not null references public.provider_sources(id),
  consent_artifact_id uuid references public.consent_artifacts(id),
  extraction_method  text not null default 'ai_extracted',
  model_id           text,
  prompt_set         jsonb not null default '{}',
  reviewer_id        uuid references public.profiles(id),
  field_provenance   jsonb not null default '{}',
  committed_at       timestamptz not null default now()
);

create table public.audit_log (
  id         bigserial primary key,
  org_id     uuid not null references public.organizations(id),
  record_id  uuid references public.ingestion_records(id),
  actor_type actor_t not null,
  actor_id   text,
  event      text not null,
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now(),
  prev_hash  text,
  hash       text not null default ''
);
create index idx_audit_log_record on public.audit_log(record_id, id);
create index idx_audit_log_org_time on public.audit_log(org_id, created_at desc);
create index idx_audit_log_event on public.audit_log(event);

create table public.pipeline_jobs (
  id           uuid primary key default gen_random_uuid(),
  record_id    uuid not null references public.ingestion_records(id) on delete cascade,
  stage        job_stage_t not null,
  status       job_status_t not null default 'queued',
  attempts     integer not null default 0,
  max_attempts integer not null default 2,
  run_at       timestamptz not null default now(),
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index idx_pipeline_jobs_due on public.pipeline_jobs(status, run_at);
create unique index uq_pipeline_jobs_active_stage on public.pipeline_jobs(record_id, stage) where status in ('queued','running');

create table public.terminology_concepts (
  id             uuid primary key default gen_random_uuid(),
  system         terminology_sys_t not null,
  code           text not null,
  display        text not null,
  synonyms       text[] not null default '{}',
  embedding      extensions.vector(1024),
  resource_types text[] not null default '{}',
  unique (system, code)
);
create index idx_terminology_embedding on public.terminology_concepts using hnsw (embedding extensions.vector_cosine_ops);
create index idx_terminology_display_trgm on public.terminology_concepts using gin (display extensions.gin_trgm_ops);
create index idx_terminology_fts on public.terminology_concepts using gin (to_tsvector('simple', display));

create table public.knowledge_docs (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('fhir_profile','abdm_ig','drug_brand_map','abbreviation','layout_note')),
  source_id  uuid references public.provider_sources(id),
  title      text not null,
  content    text not null,
  embedding  extensions.vector(1024),
  created_at timestamptz not null default now()
);
create index idx_knowledge_docs_embedding on public.knowledge_docs using hnsw (embedding extensions.vector_cosine_ops);

create table public.eval_samples (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id),
  source_label text not null,
  source_id    uuid references public.provider_sources(id),
  doc_type     doc_t not null,
  origin       eval_origin_t not null,
  storage_path text,
  expected     jsonb not null,
  agreement    numeric(4,3),
  ambiguous    boolean not null default false,
  split        eval_split_t not null default 'dev',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index idx_eval_samples_split on public.eval_samples(org_id, split, doc_type);

create table public.source_metrics_daily (
  source_id           uuid not null references public.provider_sources(id) on delete cascade,
  day                 date not null,
  records             integer not null default 0,
  stp_count           integer not null default 0,
  escalated           integer not null default 0,
  review_changed      integer not null default 0,
  escalation_precision numeric(5,4),
  mean_review_s       numeric(10,2),
  accuracy_gold       numeric(5,4),
  holdback_error_rate numeric(5,4),
  cost_usd            numeric(12,4) not null default 0,
  downstream_errors   integer not null default 0,
  segment             jsonb not null default '{}',
  primary key (source_id, day)
);

create table public.downstream_errors (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id),
  record_id        uuid not null references public.ingestion_records(id),
  fhir_resource_id uuid references public.fhir_resources(id),
  reported_by      uuid not null references public.profiles(id),
  description      text not null,
  severity         text not null check (severity in ('low','medium','high','critical')),
  status           error_status_t not null default 'open',
  source_paused    boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table public.threshold_proposals (
  id            uuid primary key default gen_random_uuid(),
  source_id     uuid not null references public.provider_sources(id) on delete cascade,
  resource_type text not null,
  current_value numeric(4,3) not null,
  proposed_value numeric(4,3) not null check (proposed_value between 0.5 and 0.999),
  evidence      jsonb not null,
  status        proposal_status_t not null default 'pending',
  decided_by    uuid references public.profiles(id),
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.source_flags (
  id         uuid primary key default gen_random_uuid(),
  source_id  uuid not null references public.provider_sources(id) on delete cascade,
  flagged_by uuid not null references public.profiles(id),
  note       text not null,
  created_at timestamptz not null default now()
);

-- ---------- 5. RLS helper functions needing tables -------------------
create or replace function public.record_in_my_org(p_record_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ingestion_records r
                 where r.id = p_record_id and r.org_id = public.current_org_id())
$$;

create or replace function public.source_in_my_org(p_source_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.provider_sources s
                 where s.id = p_source_id and s.org_id = public.current_org_id())
$$;

-- ---------- 6. updated_at triggers ----------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'organizations','profiles','provider_sources','patients','consent_artifacts',
    'prompt_versions','ingestion_records','mapped_resources','routing_thresholds',
    'review_tasks','fhir_resources','pipeline_jobs','eval_samples',
    'downstream_errors','threshold_proposals'] loop
    execute format('create trigger trg_%1$s_updated_at before update on public.%1$I
                    for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ---------- 7. Audit log: hash chain + immutability ------------------
create or replace function public.audit_log_before_insert() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare v_prev text;
begin
  perform pg_advisory_xact_lock(hashtext(new.org_id::text));
  select hash into v_prev from public.audit_log where org_id = new.org_id order by id desc limit 1;
  new.prev_hash := v_prev;
  new.hash := encode(extensions.digest(
      coalesce(v_prev,'') || '|' || new.org_id::text || '|' || new.id::text || '|' ||
      new.event || '|' || new.payload::text || '|' || new.created_at::text, 'sha256'), 'hex');
  return new;
end $$;
create trigger trg_audit_log_hash before insert on public.audit_log
  for each row execute function public.audit_log_before_insert();

create or replace function public.audit_log_immutable() returns trigger
language plpgsql as $$
begin raise exception 'audit_log is append-only'; end $$;
create trigger trg_audit_log_no_update before update or delete on public.audit_log
  for each row execute function public.audit_log_immutable();
create trigger trg_audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function public.audit_log_immutable();

-- Verify an org's chain; returns first broken id or null
create or replace function public.verify_audit_chain(p_org uuid) returns bigint
language plpgsql stable security definer set search_path = public, extensions as $$
declare r record; v_prev text := null; v_calc text;
begin
  for r in select * from public.audit_log where org_id = p_org order by id loop
    v_calc := encode(extensions.digest(coalesce(v_prev,'') || '|' || r.org_id::text || '|' || r.id::text || '|' ||
              r.event || '|' || r.payload::text || '|' || r.created_at::text, 'sha256'), 'hex');
    if r.prev_hash is distinct from v_prev or r.hash <> v_calc then return r.id; end if;
    v_prev := r.hash;
  end loop;
  return null;
end $$;

-- ---------- 8. FHIR resource versioning -----------------------------
create or replace function public.fhir_resources_version() returns trigger
language plpgsql as $$
begin
  insert into public.fhir_resource_versions(fhir_resource_id, version_id, resource)
  values (old.id, old.version_id, old.resource);
  new.version_id := old.version_id + 1;
  return new;
end $$;
create trigger trg_fhir_resources_version before update of resource on public.fhir_resources
  for each row execute function public.fhir_resources_version();

-- ---------- 9. Queue claim function ---------------------------------
create or replace function public.claim_jobs(p_limit integer, p_worker text)
returns setof public.pipeline_jobs
language plpgsql security definer set search_path = public as $$
begin
  -- recover jobs whose worker died (locked > 5 min)
  update public.pipeline_jobs
     set status = 'queued', locked_at = null, locked_by = null
   where status = 'running' and locked_at < now() - interval '5 minutes';

  return query
  with picked as (
    select id from public.pipeline_jobs
     where status = 'queued' and run_at <= now()
     order by run_at
     limit p_limit
     for update skip locked)
  update public.pipeline_jobs j
     set status = 'running', locked_at = now(), locked_by = p_worker, attempts = j.attempts + 1
    from picked
   where j.id = picked.id
  returning j.*;
end $$;


-- ---------- 7b. Audit row integrity check (also shipped as migration 0003) --
-- For the given audit rows of one organisation, reports whether each row's own hash is correct AND
-- whether it links to the hash of the immediately preceding row in that organisation's chain.
create or replace function public.check_audit_rows(p_org uuid, p_ids bigint[])
returns table (id bigint, hash_ok boolean)
language sql stable security definer set search_path = public, extensions as $$
  select a.id,
         (a.hash = encode(extensions.digest(
              coalesce(a.prev_hash, '') || '|' || a.org_id::text || '|' || a.id::text || '|' ||
              a.event || '|' || a.payload::text || '|' || a.created_at::text, 'sha256'), 'hex'))
         and (a.prev_hash is not distinct from (
              select b.hash from public.audit_log b
               where b.org_id = a.org_id and b.id < a.id
               order by b.id desc limit 1))
    from public.audit_log a
   where a.org_id = p_org and a.id = any(p_ids)
$$;

revoke all on function public.check_audit_rows(uuid, bigint[]) from public, anon, authenticated;
grant execute on function public.check_audit_rows(uuid, bigint[]) to service_role;

-- ---------- 9b. Login lockout and guarded profile updates -----------
-- Atomically records a failed login; 5 failures within 15 minutes lock the account for 15 minutes.
create or replace function public.record_login_failure(p_email text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.profiles p set
    failed_logins = n.cnt,
    last_failed_login_at = now(),
    locked_until = case when n.cnt >= 5 then now() + interval '15 minutes' else p.locked_until end
  from (
    select id,
           case when last_failed_login_at is null or last_failed_login_at < now() - interval '15 minutes'
                then 1 else failed_logins + 1 end as cnt
      from public.profiles where email = lower(p_email) for update) n
  where p.id = n.id;
end $$;

create or replace function public.reset_login_failures(p_user uuid) returns void
language sql security definer set search_path = public as $$
  update public.profiles set failed_logins = 0, last_failed_login_at = null, locked_until = null
   where id = p_user
$$;

-- Updates role/active/full_name while guaranteeing the org always keeps at least one active admin.
-- p_changes keys: role, active, full_name. Raises 'not_found' or 'last_admin'.
create or replace function public.admin_update_profile(p_org uuid, p_target uuid, p_changes jsonb)
returns public.profiles
language plpgsql security definer set search_path = public as $$
declare
  cur public.profiles%rowtype;
  new_role role_t;
  new_active boolean;
  remaining integer;
begin
  perform 1 from public.profiles where org_id = p_org and role = 'admin' and active for update;
  select * into cur from public.profiles where id = p_target and org_id = p_org for update;
  if not found then raise exception 'not_found'; end if;

  new_role := coalesce((p_changes->>'role')::role_t, cur.role);
  new_active := coalesce((p_changes->>'active')::boolean, cur.active);

  if cur.role = 'admin' and cur.active and (new_role <> 'admin' or not new_active) then
    select count(*) into remaining from public.profiles
     where org_id = p_org and role = 'admin' and active and id <> p_target;
    if remaining = 0 then raise exception 'last_admin'; end if;
  end if;

  update public.profiles
     set role = new_role,
         active = new_active,
         full_name = case when p_changes ? 'full_name' then p_changes->>'full_name' else full_name end
   where id = p_target
  returning * into cur;
  return cur;
end $$;

-- ---------- 9c. Provider source helpers (also shipped as migration 0002) --
-- Creates a source, its four default threshold rows and its API key in one transaction.
-- Raises unique_violation (23505) when the name already exists in the organisation.
create or replace function public.create_source_with_defaults(
  p_org uuid, p_created_by uuid, p_name text, p_provider_type text, p_size_class size_class_t,
  p_region text, p_language text, p_doc_types doc_t[], p_regime regime_t, p_holdback numeric,
  p_default_threshold numeric, p_high_risk_threshold numeric, p_key_prefix text, p_key_hash text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.provider_sources(org_id, name, provider_type, size_class, region,
         primary_language, doc_types, consent_regime, holdback_pct, created_by)
  values (p_org, p_name, p_provider_type, p_size_class, p_region, p_language, p_doc_types,
          p_regime, p_holdback, p_created_by)
  returning id into v_id;

  insert into public.routing_thresholds(source_id, resource_type, threshold, version, active, changed_by, reason)
  values (v_id, '*', p_default_threshold, 1, true, p_created_by, 'default at creation'),
         (v_id, 'MedicationRequest', p_high_risk_threshold, 1, true, p_created_by, 'default at creation'),
         (v_id, 'AllergyIntolerance', p_high_risk_threshold, 1, true, p_created_by, 'default at creation'),
         (v_id, 'Observation', p_high_risk_threshold, 1, true, p_created_by, 'default at creation');

  insert into public.source_api_keys(source_id, key_prefix, key_hash) values (v_id, p_key_prefix, p_key_hash);
  return v_id;
end $$;

-- Appends a new threshold version and deactivates the previous one atomically.
-- Returns the new version and the previous threshold value (null when none existed).
create or replace function public.set_routing_threshold(
  p_source uuid, p_resource_type text, p_threshold numeric, p_reason text, p_changed_by uuid)
returns table (version integer, previous numeric)
language plpgsql security definer set search_path = public as $$
declare v_prev numeric; v_version integer;
begin
  perform 1 from public.provider_sources where id = p_source for update;
  if not found then raise exception 'not_found'; end if;

  select t.threshold into v_prev from public.routing_thresholds t
   where t.source_id = p_source and t.resource_type = p_resource_type and t.active;
  select coalesce(max(t.version), 0) + 1 into v_version from public.routing_thresholds t
   where t.source_id = p_source and t.resource_type = p_resource_type;

  update public.routing_thresholds t set active = false
   where t.source_id = p_source and t.resource_type = p_resource_type and t.active;
  insert into public.routing_thresholds(source_id, resource_type, threshold, version, active, changed_by, reason)
  values (p_source, p_resource_type, p_threshold, v_version, true, p_changed_by, p_reason);

  return query select v_version, v_prev;
end $$;

-- Revokes the current API key and issues a new one atomically.
create or replace function public.rotate_source_key(p_source uuid, p_key_prefix text, p_key_hash text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform 1 from public.provider_sources where id = p_source for update;
  if not found then raise exception 'not_found'; end if;
  update public.source_api_keys set revoked_at = now() where source_id = p_source and revoked_at is null;
  insert into public.source_api_keys(source_id, key_prefix, key_hash) values (p_source, p_key_prefix, p_key_hash);
end $$;

revoke all on function public.create_source_with_defaults(uuid, uuid, text, text, size_class_t, text, text, doc_t[], regime_t, numeric, numeric, numeric, text, text) from public, anon, authenticated;
revoke all on function public.set_routing_threshold(uuid, text, numeric, text, uuid) from public, anon, authenticated;
revoke all on function public.rotate_source_key(uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_source_with_defaults(uuid, uuid, text, text, size_class_t, text, text, doc_t[], regime_t, numeric, numeric, numeric, text, text) to service_role;
grant execute on function public.set_routing_threshold(uuid, text, numeric, text, uuid) to service_role;
grant execute on function public.rotate_source_key(uuid, text, text) to service_role;

-- ---------- 10. Terminology hybrid search ---------------------------
create or replace function public.search_terminology(
  p_embedding extensions.vector(1024), p_text text, p_system terminology_sys_t,
  p_resource_type text, p_limit integer default 10)
returns table (id uuid, system terminology_sys_t, code text, display text, score real)
language sql stable security definer set search_path = public, extensions as $$
  with sem as (
    select c.id, c.system, c.code, c.display,
           (1 - (c.embedding <=> p_embedding))::real as s
      from public.terminology_concepts c
     where c.system = p_system
       and (cardinality(c.resource_types) = 0 or p_resource_type = any(c.resource_types))
     order by c.embedding <=> p_embedding
     limit p_limit * 3),
  lex as (
    select c.id, c.system, c.code, c.display,
           similarity(c.display, p_text)::real as s
      from public.terminology_concepts c
     where c.system = p_system and c.display % p_text
     order by similarity(c.display, p_text) desc
     limit p_limit * 3),
  merged as (
    select * from sem union all select * from lex)
  select m.id, m.system, m.code, m.display, max(m.s)::real as score
    from merged m
   group by m.id, m.system, m.code, m.display
   order by max(m.s) desc
   limit p_limit
$$;

-- ---------- 11. Atomic commit function ------------------------------
create or replace function public.commit_record(
  p_record_id uuid, p_mode commit_mode_t, p_reviewer_id uuid default null)
returns uuid[]
language plpgsql security definer set search_path = public, extensions as $$
declare
  r public.ingestion_records%rowtype;
  v_consent consent_result_t; v_artifact uuid; v_decision decision_t;
  mr record; v_id uuid; v_ids uuid[] := '{}'; v_prov jsonb;
begin
  select * into r from public.ingestion_records where id = p_record_id for update;
  if not found then raise exception 'record_not_found'; end if;
  if r.status in ('auto_committed','committed') then raise exception 'already_committed'; end if;
  if r.patient_id is null then raise exception 'patient_required'; end if;

  select result, artifact_id into v_consent, v_artifact
    from public.consent_checks where record_id = p_record_id;
  if v_consent is distinct from 'valid' then raise exception 'consent_not_valid'; end if;

  if p_mode = 'auto' then
    select decision into v_decision from public.routing_decisions where record_id = p_record_id;
    if v_decision is distinct from 'auto_commit' then raise exception 'not_routed_auto_commit'; end if;
    if r.status <> 'routing' then raise exception 'bad_status_%', r.status; end if;
    if exists (select 1 from public.extracted_fields where record_id = p_record_id and extracted_fields.found and not extracted_fields.grounded) then
      raise exception 'ungrounded_field_present';
    end if;
  else
    if p_reviewer_id is null then raise exception 'reviewer_required'; end if;
    if not exists (select 1 from public.review_tasks where record_id = p_record_id and status = 'completed') then
      raise exception 'no_completed_review';
    end if;
  end if;

  if not exists (select 1 from public.mapped_resources where record_id = p_record_id) then
    raise exception 'nothing_to_commit';
  end if;
  if exists (select 1 from public.mapped_resources where record_id = p_record_id and validation_status <> 'pass') then
    raise exception 'validation_not_passed';
  end if;

  for mr in select * from public.mapped_resources where record_id = p_record_id loop
    v_id := mr.id;   -- keep pre-assigned id so inter-resource references stay valid
    insert into public.fhir_resources(id, org_id, record_id, patient_id, resource_type, resource, commit_mode)
    values (v_id, r.org_id, r.id, r.patient_id, mr.resource_type,
            jsonb_set(mr.resource, '{id}', to_jsonb(v_id::text)), p_mode);

    select coalesce(jsonb_object_agg(f.field_key, jsonb_build_object(
             'span', f.source_span, 'confidence', f.model_confidence, 'basis', f.basis)), '{}')
      into v_prov
      from public.extracted_fields f
     where f.record_id = r.id and f.resource_type = mr.resource_type and f.found;

    insert into public.provenance(fhir_resource_id, record_id, source_id, consent_artifact_id,
             extraction_method, model_id, prompt_set, reviewer_id, field_provenance)
    values (v_id, r.id, r.source_id, v_artifact,
            case when p_mode = 'auto' then 'ai_extracted_auto' else 'ai_extracted_human_reviewed' end,
            r.prompt_set->>'model_id', r.prompt_set, p_reviewer_id, v_prov);
    v_ids := v_ids || v_id;
  end loop;

  update public.ingestion_records
     set status = case when p_mode = 'auto' then 'auto_committed'::record_status_t else 'committed'::record_status_t end,
         completed_at = now(),
         latency_ms = (extract(epoch from (now() - created_at)) * 1000)::int
   where id = p_record_id;

  insert into public.audit_log(org_id, record_id, actor_type, actor_id, event, payload)
  values (r.org_id, r.id, case when p_mode = 'auto' then 'system'::actor_t else 'user'::actor_t end,
          p_reviewer_id::text, 'record.committed',
          jsonb_build_object('mode', p_mode, 'fhir_resource_ids', v_ids));
  return v_ids;
end $$;

-- ---------- 12. Function privileges ---------------------------------
revoke all on function public.commit_record(uuid, commit_mode_t, uuid) from public, anon, authenticated;
revoke all on function public.claim_jobs(integer, text) from public, anon, authenticated;
revoke all on function public.search_terminology(extensions.vector, text, terminology_sys_t, text, integer) from public, anon, authenticated;
revoke all on function public.verify_audit_chain(uuid) from public, anon, authenticated;
revoke all on function public.record_login_failure(text) from public, anon, authenticated;
revoke all on function public.reset_login_failures(uuid) from public, anon, authenticated;
revoke all on function public.admin_update_profile(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.commit_record(uuid, commit_mode_t, uuid) to service_role;
grant execute on function public.claim_jobs(integer, text) to service_role;
grant execute on function public.search_terminology(extensions.vector, text, terminology_sys_t, text, integer) to service_role;
grant execute on function public.verify_audit_chain(uuid) to service_role;
grant execute on function public.record_login_failure(text) to service_role;
grant execute on function public.reset_login_failures(uuid) to service_role;
grant execute on function public.admin_update_profile(uuid, uuid, jsonb) to service_role;

-- ---------- 13. Row Level Security ----------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'organizations','profiles','provider_sources','source_api_keys','patients','consent_artifacts',
    'eval_runs','prompt_versions','ingestion_records','documents','consent_checks','extracted_fields',
    'mapped_resources','field_scores','routing_thresholds','routing_decisions','review_tasks',
    'review_corrections','fhir_resources','fhir_resource_versions','provenance','audit_log',
    'pipeline_jobs','terminology_concepts','knowledge_docs','eval_samples','source_metrics_daily',
    'downstream_errors','threshold_proposals','source_flags'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
-- No policies on: source_api_keys, pipeline_jobs, fhir_resource_versions (service role only).

create policy org_select on public.organizations for select to authenticated
  using (id = public.current_org_id());

create policy profiles_select on public.profiles for select to authenticated
  using (org_id = public.current_org_id());
create policy profiles_admin_update on public.profiles for update to authenticated
  using (org_id = public.current_org_id() and public.has_role('admin'))
  with check (org_id = public.current_org_id() and public.has_role('admin'));

create policy sources_select on public.provider_sources for select to authenticated
  using (org_id = public.current_org_id());
create policy sources_insert on public.provider_sources for insert to authenticated
  with check (org_id = public.current_org_id() and public.has_role('integration_engineer','admin'));
create policy sources_update on public.provider_sources for update to authenticated
  using (org_id = public.current_org_id() and public.has_role('integration_engineer','admin'))
  with check (org_id = public.current_org_id() and public.has_role('integration_engineer','admin'));

create policy patients_select on public.patients for select to authenticated
  using (org_id = public.current_org_id() and public.has_role('integration_engineer','reviewer','admin'));

create policy consent_artifacts_select on public.consent_artifacts for select to authenticated
  using (public.has_role('integration_engineer','admin') and exists (
    select 1 from public.patients p where p.id = patient_id and p.org_id = public.current_org_id()));

create policy records_select on public.ingestion_records for select to authenticated
  using (org_id = public.current_org_id() and public.has_role('integration_engineer','reviewer','admin'));

create policy documents_select on public.documents for select to authenticated
  using (public.has_role('integration_engineer','reviewer','admin') and public.record_in_my_org(record_id));
create policy consent_checks_select on public.consent_checks for select to authenticated
  using (public.has_role('integration_engineer','reviewer','admin') and public.record_in_my_org(record_id));
create policy extracted_fields_select on public.extracted_fields for select to authenticated
  using (public.has_role('integration_engineer','reviewer','admin') and public.record_in_my_org(record_id));
create policy mapped_resources_select on public.mapped_resources for select to authenticated
  using (public.has_role('integration_engineer','reviewer','admin') and public.record_in_my_org(record_id));
create policy field_scores_select on public.field_scores for select to authenticated
  using (public.has_role('integration_engineer','reviewer','admin') and public.record_in_my_org(record_id));
create policy routing_decisions_select on public.routing_decisions for select to authenticated
  using (public.has_role('integration_engineer','reviewer','admin') and public.record_in_my_org(record_id));
create policy provenance_select on public.provenance for select to authenticated
  using (public.has_role('integration_engineer','reviewer','admin') and public.record_in_my_org(record_id));

create policy thresholds_select on public.routing_thresholds for select to authenticated
  using (public.source_in_my_org(source_id));
create policy thresholds_insert on public.routing_thresholds for insert to authenticated
  with check (public.source_in_my_org(source_id) and public.has_role('integration_engineer','admin'));

create policy review_tasks_select on public.review_tasks for select to authenticated
  using (public.has_role('reviewer','admin') and public.record_in_my_org(record_id));
create policy review_corrections_select on public.review_corrections for select to authenticated
  using (public.has_role('reviewer','admin') and public.record_in_my_org(record_id));

create policy fhir_select on public.fhir_resources for select to authenticated
  using (org_id = public.current_org_id() and public.has_role('integration_engineer','reviewer','admin'));

create policy audit_select on public.audit_log for select to authenticated
  using (org_id = public.current_org_id() and public.has_role('admin'));

create policy prompt_versions_select on public.prompt_versions for select to authenticated
  using (public.has_role('integration_engineer','admin'));
create policy eval_runs_select on public.eval_runs for select to authenticated
  using (org_id = public.current_org_id() and public.has_role('integration_engineer','admin'));
create policy eval_samples_select on public.eval_samples for select to authenticated
  using (org_id = public.current_org_id() and public.has_role('admin'));

create policy terminology_select on public.terminology_concepts for select to authenticated using (true);
create policy knowledge_select on public.knowledge_docs for select to authenticated using (true);

create policy metrics_select on public.source_metrics_daily for select to authenticated
  using (public.source_in_my_org(source_id));

create policy downstream_errors_select on public.downstream_errors for select to authenticated
  using (org_id = public.current_org_id() and public.has_role('reviewer','admin'));
create policy proposals_select on public.threshold_proposals for select to authenticated
  using (public.source_in_my_org(source_id) and public.has_role('integration_engineer','admin'));
create policy source_flags_select on public.source_flags for select to authenticated
  using (public.source_in_my_org(source_id) and public.has_role('admin','reviewer'));

-- ---------- 14. Storage bucket + policies ---------------------------
-- Object path convention: {org_id}/{record_id}/{original_filename}
-- All uploads are server-side (service role). Authenticated users may only READ via signed URLs
-- generated by the API after an authz check; this policy additionally lets them read within their org.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('source-documents', 'source-documents', false, 26214400,
        array['application/pdf','image/png','image/jpeg','image/tiff','text/plain','application/hl7-v2','application/octet-stream'])
on conflict (id) do nothing;

create policy source_documents_read on storage.objects for select to authenticated
  using (bucket_id = 'source-documents'
         and (storage.foldername(name))[1] = public.current_org_id()::text
         and public.has_role('integration_engineer','reviewer','admin'));

-- ---------- 15. Realtime ---------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.ingestion_records;
  alter publication supabase_realtime add table public.review_tasks;
exception when duplicate_object then null; end $$;

-- ---------- 16. Seed: default prompt placeholders are loaded by `npm run seed:prompts` -----
-- ---------- 17. Bootstrap (run manually once, replace values) ---------
-- 1) Create the first user in Dashboard > Authentication > Users, copy its UUID.
-- 2) insert into public.organizations(name) values ('My Platform') returning id;
-- 3) insert into public.profiles(id, org_id, email, full_name, role)
--    values ('<auth-user-uuid>', '<org-uuid>', lower('<admin-email>'), 'First Admin', 'admin');

-- ---------- 14. Review functions (migration 0006) ----------
-- Review queue functions (spec 09). Each runs as one transaction.

-- Approve: apply the reviewer's final resources and field values, store one correction row per field,
-- complete the task and commit the record in human mode. Any exception rolls everything back.
create or replace function public.submit_review(
  p_task uuid, p_reviewer uuid,
  p_resources jsonb, p_deleted_resources uuid[],
  p_fields jsonb, p_removed_fields text[],
  p_corrections jsonb, p_counts jsonb)
returns uuid[]
language plpgsql security definer set search_path = public, extensions as $$
declare
  t public.review_tasks%rowtype;
  r public.ingestion_records%rowtype;
  item jsonb;
begin
  select * into t from public.review_tasks where id = p_task for update;
  if not found then raise exception 'task_not_found'; end if;
  if t.status <> 'claimed' or t.claimed_by is distinct from p_reviewer or t.lock_expires_at < now() then
    raise exception 'lock_lost';
  end if;
  select * into r from public.ingestion_records where id = t.record_id for update;
  if r.status <> 'in_review' then raise exception 'task_closed'; end if;

  delete from public.mapped_resources where record_id = r.id and id = any(p_deleted_resources);

  for item in select * from jsonb_array_elements(p_resources) loop
    insert into public.mapped_resources(id, record_id, resource_type, resource, codings, flags, source_ref,
                                        validation_status, validation_issues, profile_url)
    values ((item->>'id')::uuid, r.id, item->>'resource_type', item->'resource', item->'codings',
            array(select jsonb_array_elements_text(item->'flags')), item->>'source_ref',
            'pass', coalesce(item->'validation_issues', '[]'::jsonb), item->>'profile_url')
    on conflict (id) do update set
      resource = excluded.resource, codings = excluded.codings, flags = excluded.flags,
      source_ref = excluded.source_ref, validation_status = 'pass',
      validation_issues = excluded.validation_issues, profile_url = excluded.profile_url, updated_at = now();
  end loop;

  for item in select * from jsonb_array_elements(p_fields) loop
    insert into public.extracted_fields(record_id, field_key, resource_type, value, found, source_page,
                                        source_span, grounded, basis, model_confidence)
    values (r.id, item->>'field_key', item->>'resource_type', item->'value', true,
            nullif(item->>'source_page', '')::int, item->'source_span', true,
            (item->>'basis')::basis_t, nullif(item->>'model_confidence', '')::numeric)
    on conflict (record_id, field_key) do update set
      value = excluded.value, found = true, source_page = excluded.source_page,
      source_span = excluded.source_span, grounded = true, basis = excluded.basis,
      model_confidence = excluded.model_confidence;
  end loop;

  update public.extracted_fields
     set found = false, value = null, source_span = null, source_page = null, grounded = false
   where record_id = r.id and field_key = any(p_removed_fields);

  for item in select * from jsonb_array_elements(p_corrections) loop
    insert into public.review_corrections(task_id, record_id, source_id, field_key, action, original_value,
                                          corrected_value, original_code, corrected_code, source_span, note, reviewer_id)
    values (p_task, r.id, r.source_id, item->>'field_key', (item->>'action')::review_action_t,
            item->'original_value', item->'corrected_value', item->'original_code', item->'corrected_code',
            item->'source_span', item->>'note', p_reviewer);
  end loop;

  update public.review_tasks set status = 'completed', completed_at = now() where id = p_task;

  insert into public.audit_log(org_id, record_id, actor_type, actor_id, event, payload)
  values (r.org_id, r.id, 'user', p_reviewer::text, 'review.submitted',
          p_counts || jsonb_build_object('task_id', p_task));

  return public.commit_record(r.id, 'human', p_reviewer);
end $$;

-- Reject the whole record: store the field decisions, complete the task, mark the record rejected.
create or replace function public.reject_review(
  p_task uuid, p_reviewer uuid, p_corrections jsonb, p_counts jsonb)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  t public.review_tasks%rowtype;
  r public.ingestion_records%rowtype;
  item jsonb;
begin
  select * into t from public.review_tasks where id = p_task for update;
  if not found then raise exception 'task_not_found'; end if;
  if t.status <> 'claimed' or t.claimed_by is distinct from p_reviewer or t.lock_expires_at < now() then
    raise exception 'lock_lost';
  end if;
  select * into r from public.ingestion_records where id = t.record_id for update;
  if r.status <> 'in_review' then raise exception 'task_closed'; end if;

  for item in select * from jsonb_array_elements(p_corrections) loop
    insert into public.review_corrections(task_id, record_id, source_id, field_key, action, original_value,
                                          corrected_value, original_code, corrected_code, source_span, note, reviewer_id)
    values (p_task, r.id, r.source_id, item->>'field_key', (item->>'action')::review_action_t,
            item->'original_value', item->'corrected_value', item->'original_code', item->'corrected_code',
            item->'source_span', item->>'note', p_reviewer);
  end loop;

  update public.review_tasks set status = 'completed', completed_at = now() where id = p_task;
  update public.ingestion_records
     set status = 'rejected', status_reason = 'reviewer_rejected', completed_at = now() where id = r.id;
  insert into public.audit_log(org_id, record_id, actor_type, actor_id, event, payload)
  values (r.org_id, r.id, 'user', p_reviewer::text, 'record.rejected',
          p_counts || jsonb_build_object('task_id', p_task, 'reason', 'reviewer_rejected'));
end $$;

-- Lock expiry sweep (worker tick): reopen tasks whose lock ran out and return their records to the queue.
create or replace function public.release_expired_review_locks()
returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare ids uuid[];
begin
  with expired as (
    update public.review_tasks
       set status = 'open', claimed_by = null, claimed_at = null, lock_expires_at = null
     where status = 'claimed' and lock_expires_at < now()
    returning record_id)
  select array_agg(record_id) into ids from expired;
  if ids is null then return 0; end if;

  update public.ingestion_records set status = 'needs_review' where id = any(ids) and status = 'in_review';
  insert into public.audit_log(org_id, record_id, actor_type, event, payload)
  select org_id, id, 'system', 'review.released', jsonb_build_object('reason', 'lock_expired')
    from public.ingestion_records where id = any(ids);
  return cardinality(ids);
end $$;

revoke all on function public.submit_review(uuid, uuid, jsonb, uuid[], jsonb, text[], jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.reject_review(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.release_expired_review_locks() from public, anon, authenticated;
grant execute on function public.submit_review(uuid, uuid, jsonb, uuid[], jsonb, text[], jsonb, jsonb) to service_role;
grant execute on function public.reject_review(uuid, uuid, jsonb, jsonb) to service_role;
grant execute on function public.release_expired_review_locks() to service_role;

-- ---------- 15. Safety controls (migration 0007) ----------
-- Safety controls (spec 14): incident close-out fields and a daily model spend ledger.

alter table public.downstream_errors
  add column if not exists root_cause text check (root_cause in ('extraction','mapping','ocr','threshold','consent','other')),
  add column if not exists resolution_note text,
  add column if not exists resolved_by uuid references public.profiles(id),
  add column if not exists resolved_at timestamptz;

create index if not exists idx_downstream_errors_org_status on public.downstream_errors(org_id, status, created_at desc);

-- One row per UTC day: what the language model cost, used for the daily spend cap.
create table if not exists public.llm_spend_daily (
  day date primary key,
  usd numeric(12,4) not null default 0
);
alter table public.llm_spend_daily enable row level security;

-- Adds to today's spend and returns {before, after}, so the caller can alert once when the cap is crossed.
create or replace function public.add_llm_spend(p_usd numeric)
returns numeric[]
language plpgsql security definer set search_path = public as $$
declare v_day date := (now() at time zone 'utc')::date; v_before numeric; v_after numeric;
begin
  insert into public.llm_spend_daily(day, usd) values (v_day, 0) on conflict (day) do nothing;
  select usd into v_before from public.llm_spend_daily where day = v_day for update;
  update public.llm_spend_daily set usd = usd + p_usd where day = v_day returning usd into v_after;
  return array[v_before, v_after];
end $$;

create or replace function public.get_llm_spend()
returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select usd from public.llm_spend_daily where day = (now() at time zone 'utc')::date), 0)
$$;

revoke all on function public.add_llm_spend(numeric) from public, anon, authenticated;
revoke all on function public.get_llm_spend() from public, anon, authenticated;
grant execute on function public.add_llm_spend(numeric) to service_role;
grant execute on function public.get_llm_spend() to service_role;
