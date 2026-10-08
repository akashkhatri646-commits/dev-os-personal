-- Durable sliding-window rate limiting. The in-memory limiter only counts per server instance, which on
-- serverless hosting lets an attacker spread attempts across instances; this counts in the database.
-- Service role only: no user-facing policies, so nobody can read or reset their own counts.

create table if not exists public.rate_limit_events (
  id         uuid        primary key default gen_random_uuid(),
  key        text        not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_rate_limit_events_lookup on public.rate_limit_events (key, created_at desc);
alter table public.rate_limit_events enable row level security;

-- Records one hit for `p_key` and returns 0 when it is allowed, or the number of seconds until the oldest
-- hit in the window expires when the limit is already reached (the hit is then not recorded).
create or replace function public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count  integer;
  v_oldest timestamptz;
begin
  -- One caller per key at a time, so two parallel requests cannot both take the last slot.
  perform pg_advisory_xact_lock(hashtext(p_key));

  delete from public.rate_limit_events where key = p_key and created_at < now() - make_interval(secs => p_window_seconds);
  select count(*), min(created_at) into v_count, v_oldest from public.rate_limit_events where key = p_key;

  if v_count >= p_limit then
    return greatest(1, ceil(extract(epoch from (v_oldest + make_interval(secs => p_window_seconds) - now())))::integer);
  end if;

  insert into public.rate_limit_events(key) values (p_key);
  -- Housekeeping: now and then drop everything old, for keys that were never seen again.
  if random() < 0.01 then
    delete from public.rate_limit_events where created_at < now() - interval '1 day';
  end if;
  return 0;
end $$;

revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
