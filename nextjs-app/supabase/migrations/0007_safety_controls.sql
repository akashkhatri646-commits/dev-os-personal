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
