-- =====================================================================
-- 0002_source_functions.sql — atomic helpers for provider sources (spec 02)
-- Run once in the Supabase SQL Editor AFTER 0001_baseline.sql.
-- (Fresh projects get these functions from docs/specs/supabase-schema.sql instead.)
-- =====================================================================

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
