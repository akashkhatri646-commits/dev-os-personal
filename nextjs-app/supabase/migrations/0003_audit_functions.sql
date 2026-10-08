-- =====================================================================
-- 0003_audit_functions.sql — per-row audit integrity check (spec 10 §4)
-- Run once in the Supabase SQL Editor AFTER 0002_source_functions.sql.
-- (Fresh projects get this function from docs/specs/supabase-schema.sql instead.)
-- =====================================================================

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
