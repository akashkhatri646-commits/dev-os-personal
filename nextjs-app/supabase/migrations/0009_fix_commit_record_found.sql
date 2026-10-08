-- Fix: commit_record failed with "column reference "found" is ambiguous" on every automatic commit, because
-- `found` is also the name of a PL/pgSQL variable. The column is now qualified. Safe to run again; databases
-- created from the updated baseline already have this version.
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

revoke all on function public.commit_record(uuid, commit_mode_t, uuid) from public, anon, authenticated;
grant execute on function public.commit_record(uuid, commit_mode_t, uuid) to service_role;
