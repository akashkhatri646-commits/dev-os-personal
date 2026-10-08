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
