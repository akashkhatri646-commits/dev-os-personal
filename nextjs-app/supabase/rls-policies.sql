-- Security baseline for the Supabase SQL Editor. Safe to run any number of times.
-- 1. Row Level Security on every table in the public schema (including tables added later).
-- 2. Durable rate limiting (same objects as migrations/0008_rate_limit.sql).
-- 3. A check that lists anything still open.
--
-- Policies that grant access to each table live in migrations/0001_baseline.sql. A table with RLS on and no
-- policy is readable only through the service role, which is the intended default for new tables.

-- 1. RLS everywhere ---------------------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- 2. Rate limiting ----------------------------------------------------------------------------------------
create table if not exists public.rate_limit_events (
  id         uuid        primary key default gen_random_uuid(),
  key        text        not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_rate_limit_events_lookup on public.rate_limit_events (key, created_at desc);
alter table public.rate_limit_events enable row level security;
-- No user-facing policies: only the service role can read or write counts.

create or replace function public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count  integer;
  v_oldest timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext(p_key));
  delete from public.rate_limit_events where key = p_key and created_at < now() - make_interval(secs => p_window_seconds);
  select count(*), min(created_at) into v_count, v_oldest from public.rate_limit_events where key = p_key;
  if v_count >= p_limit then
    return greatest(1, ceil(extract(epoch from (v_oldest + make_interval(secs => p_window_seconds) - now())))::integer);
  end if;
  insert into public.rate_limit_events(key) values (p_key);
  if random() < 0.01 then
    delete from public.rate_limit_events where created_at < now() - interval '1 day';
  end if;
  return 0;
end $$;

revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;

-- 3. Verification: every query below should return no rows ------------------------------------------------
-- Tables without RLS
select tablename as table_without_rls
  from pg_tables
 where schemaname = 'public' and not rowsecurity;

-- Functions that anonymous or signed-in users can call directly (the app calls them with the service role only)
select p.proname as function_open_to_users
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.prosecdef
   and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
   and p.proname not in ('current_org_id', 'current_app_role', 'has_role', 'record_in_my_org', 'source_in_my_org');

-- The document bucket must be private
select id as public_bucket from storage.buckets where public;
