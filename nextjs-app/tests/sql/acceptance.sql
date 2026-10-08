-- Database acceptance tests (docs/specs/15 §4.2, spec 10 §8, spec 09, spec 14).
--
-- HOW TO RUN: paste the whole file into the Supabase SQL Editor (or run it with psql as the postgres
-- owner) AFTER migrations 0001-0007 are applied. It never keeps anything: all test data is created inside
-- one transaction that ends with an error on purpose, so the database is left exactly as it was. The
-- error message is the report:
--
--     ACCEPTANCE RESULT: 24 passed, 0 failed, 2 skipped
--     PASS  commit_record refuses without a valid consent check
--     FAIL  ...  (detail)
--     SKIP  ...  (reason)
--
-- "Failed > 0" is a real defect. "Skipped" means a precondition was missing (for example no profile exists
-- to act as the reviewer, or auth.users cannot be written from this role).
--
-- It briefly locks audit_log (to disable and re-enable a trigger inside the transaction). Run it when the
-- worker is idle, never on a database holding real patient data you are not allowed to touch.

-- Helper: true when the statement fails with a message containing the given text. Temporary: it lives only
-- for this session.
create or replace function pg_temp.raises(p_sql text, p_contains text) returns boolean
language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return position(p_contains in sqlerrm) > 0;
end $$;

do $$
declare
  v_results text[] := '{}';
  v_passed int := 0;
  v_failed int := 0;
  v_skipped int := 0;

  v_org uuid; v_org2 uuid; v_src uuid; v_pat uuid; v_user uuid;
  v_rec uuid; v_rec2 uuid; v_rec3 uuid; v_res1 uuid; v_res2 uuid; v_task uuid; v_job uuid;
  v_ids uuid[]; v_count int; v_text text; v_num numeric; v_arr numeric[]; v_bad bigint;
  v_viewer uuid; v_viewer_ok boolean := false;
begin
  -- ---------- fixtures ----------
  insert into public.organizations(name) values ('acceptance-org-' || gen_random_uuid()) returning id into v_org;
  insert into public.provider_sources(org_id, name, provider_type, size_class)
    values (v_org, 'acceptance-source', 'hospital', 'small') returning id into v_src;
  insert into public.patients(org_id, source_id, mrn_hash) values (v_org, v_src, 'acceptance-hash') returning id into v_pat;
  select id into v_user from public.profiles where active order by created_at limit 1;

  -- A record at the routing stage with everything a commit needs.
  insert into public.ingestion_records(org_id, source_id, patient_id, doc_type, input_kind, data_categories, status, content_sha256, prompt_set)
    values (v_org, v_src, v_pat, 'discharge_summary', 'text', array['DischargeSummary'], 'routing', 'sha-1', '{"model_id":"test-model"}') returning id into v_rec;

  -- ---------- 1. commit_record preconditions ----------
  insert into public.consent_checks(record_id, result, required_categories, regime) values (v_rec, 'missing', array['DischargeSummary'], 'abdm');
  insert into public.routing_decisions(record_id, aggregate_score, thresholds_applied, validation_result, decision, reasoning_trace, rule_version)
    values (v_rec, 0.99, '{}', 'pass', 'auto_commit', 'test', 'route-v1');
  insert into public.mapped_resources(record_id, resource_type, resource, validation_status)
    values (v_rec, 'Condition', '{"resourceType":"Condition"}', 'pass') returning id into v_res1;
  insert into public.mapped_resources(record_id, resource_type, resource, validation_status)
    values (v_rec, 'Observation', '{"resourceType":"Observation"}', 'pass') returning id into v_res2;

  if pg_temp.raises(format('select public.commit_record(%L, ''auto'')', v_rec), 'consent_not_valid') then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  commit_record refuses without a valid consent check';
  else v_failed := v_failed + 1; v_results := v_results || 'FAIL  commit_record committed (or failed differently) without valid consent'; end if;

  update public.consent_checks set result = 'valid' where record_id = v_rec;

  update public.routing_decisions set decision = 'escalate' where record_id = v_rec;
  if pg_temp.raises(format('select public.commit_record(%L, ''auto'')', v_rec), 'not_routed_auto_commit') then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  commit_record (auto) refuses a record that was not routed to auto-commit';
  else v_failed := v_failed + 1; v_results := v_results || 'FAIL  commit_record (auto) accepted an escalated record'; end if;
  update public.routing_decisions set decision = 'auto_commit' where record_id = v_rec;

  update public.mapped_resources set validation_status = 'fail' where id = v_res2;
  if pg_temp.raises(format('select public.commit_record(%L, ''auto'')', v_rec), 'validation_not_passed') then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  commit_record refuses while any resource has not passed validation';
  else v_failed := v_failed + 1; v_results := v_results || 'FAIL  commit_record accepted a resource that failed validation'; end if;
  update public.mapped_resources set validation_status = 'pass' where id = v_res2;

  insert into public.extracted_fields(record_id, field_key, resource_type, value, found, source_span, grounded)
    values (v_rec, 'diagnosis[0].text', 'Condition', '"x"', true, '{"quote":"x"}', false);
  if pg_temp.raises(format('select public.commit_record(%L, ''auto'')', v_rec), 'ungrounded_field_present') then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  commit_record (auto) refuses a found value that is not grounded';
  else v_failed := v_failed + 1; v_results := v_results || 'FAIL  commit_record (auto) accepted an ungrounded value'; end if;
  update public.extracted_fields set grounded = true where record_id = v_rec;

  if pg_temp.raises(format('select public.commit_record(%L, ''human'')', v_rec), 'reviewer_required') then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  commit_record (human) needs a reviewer';
  else v_failed := v_failed + 1; v_results := v_results || 'FAIL  commit_record (human) accepted no reviewer'; end if;

  if v_user is not null then
    if pg_temp.raises(format('select public.commit_record(%L, ''human'', %L)', v_rec, v_user), 'no_completed_review') then
      v_passed := v_passed + 1; v_results := v_results || 'PASS  commit_record (human) needs a completed review task';
    else v_failed := v_failed + 1; v_results := v_results || 'FAIL  commit_record (human) accepted a record with no completed review'; end if;
  else
    v_skipped := v_skipped + 1; v_results := v_results || 'SKIP  commit_record (human) review check: no profile exists to act as reviewer';
  end if;

  insert into public.ingestion_records(org_id, source_id, patient_id, doc_type, input_kind, data_categories, status, content_sha256)
    values (v_org, v_src, v_pat, 'discharge_summary', 'text', array['DischargeSummary'], 'routing', 'sha-empty') returning id into v_rec2;
  insert into public.consent_checks(record_id, result, required_categories, regime) values (v_rec2, 'valid', array['DischargeSummary'], 'abdm');
  insert into public.routing_decisions(record_id, aggregate_score, thresholds_applied, validation_result, decision, reasoning_trace, rule_version)
    values (v_rec2, 0.99, '{}', 'pass', 'auto_commit', 'test', 'route-v1');
  if pg_temp.raises(format('select public.commit_record(%L, ''auto'')', v_rec2), 'nothing_to_commit') then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  commit_record refuses a record with no resources';
  else v_failed := v_failed + 1; v_results := v_results || 'FAIL  commit_record committed an empty record'; end if;

  select count(*) into v_count from public.fhir_resources where record_id in (v_rec, v_rec2);
  if v_count = 0 then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  every refused commit wrote nothing';
  else v_failed := v_failed + 1; v_results := v_results || format('FAIL  refused commits left %s resources behind', v_count); end if;

  -- ---------- 2. a successful commit is atomic and complete ----------
  v_ids := public.commit_record(v_rec, 'auto');
  select count(*) into v_count from public.fhir_resources where record_id = v_rec;
  if cardinality(v_ids) = 2 and v_count = 2 then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  commit_record writes one fhir_resource per mapped resource, keeping their ids';
  else v_failed := v_failed + 1; v_results := v_results || format('FAIL  commit wrote %s resources for 2 mapped', v_count); end if;

  select count(*) into v_count from public.provenance where record_id = v_rec and extraction_method = 'ai_extracted_auto';
  if v_count = 2 then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  every committed resource has provenance (ai_extracted_auto)';
  else v_failed := v_failed + 1; v_results := v_results || format('FAIL  %s provenance rows for 2 resources', v_count); end if;

  select count(*) into v_count from public.audit_log where record_id = v_rec and event = 'record.committed';
  if v_count = 1 and (select status from public.ingestion_records where id = v_rec) = 'auto_committed' then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  commit sets auto_committed and appends exactly one record.committed event';
  else v_failed := v_failed + 1; v_results := v_results || format('FAIL  %s record.committed events / wrong status', v_count); end if;

  if pg_temp.raises(format('select public.commit_record(%L, ''auto'')', v_rec), 'already_committed') then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  committing twice is refused (already_committed)';
  else v_failed := v_failed + 1; v_results := v_results || 'FAIL  a second commit was accepted'; end if;
  select count(*) into v_count from public.fhir_resources where record_id = v_rec;
  if v_count = 2 then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  a repeat commit never duplicates resources';
  else v_failed := v_failed + 1; v_results := v_results || format('FAIL  repeat commit left %s resources', v_count); end if;

  -- ---------- 3. the audit log is append-only and tamper-evident ----------
  if pg_temp.raises(format('update public.audit_log set payload = ''{}'' where record_id = %L', v_rec), 'append-only') then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  UPDATE on audit_log is refused';
  else v_failed := v_failed + 1; v_results := v_results || 'FAIL  audit_log accepted an UPDATE'; end if;
  if pg_temp.raises(format('delete from public.audit_log where record_id = %L', v_rec), 'append-only') then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  DELETE on audit_log is refused';
  else v_failed := v_failed + 1; v_results := v_results || 'FAIL  audit_log accepted a DELETE'; end if;
  if pg_temp.raises('truncate public.audit_log', 'append-only') then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  TRUNCATE on audit_log is refused';
  else v_failed := v_failed + 1; v_results := v_results || 'FAIL  audit_log accepted a TRUNCATE'; end if;

  if public.verify_audit_chain(v_org) is null then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  verify_audit_chain finds an untouched chain intact';
  else v_failed := v_failed + 1; v_results := v_results || 'FAIL  verify_audit_chain reports a break in an untouched chain'; end if;

  -- Tamper as the table owner by switching the guard off, then back on; the transaction is rolled back at the end anyway.
  select min(id) into v_bad from public.audit_log where org_id = v_org;
  alter table public.audit_log disable trigger trg_audit_log_no_update;
  update public.audit_log set payload = '{"tampered":true}' where id = v_bad;
  alter table public.audit_log enable trigger trg_audit_log_no_update;
  if public.verify_audit_chain(v_org) = v_bad then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  verify_audit_chain returns the id of a tampered entry';
  else v_failed := v_failed + 1; v_results := v_results || 'FAIL  verify_audit_chain did not find the tampered entry'; end if;

  -- ---------- 4. review functions ----------
  if v_user is not null then
    insert into public.ingestion_records(org_id, source_id, patient_id, doc_type, input_kind, data_categories, status, content_sha256)
      values (v_org, v_src, v_pat, 'discharge_summary', 'text', array['DischargeSummary'], 'in_review', 'sha-review') returning id into v_rec3;
    insert into public.review_tasks(record_id, status, claimed_by, claimed_at, lock_expires_at)
      values (v_rec3, 'claimed', v_user, now(), now() - interval '1 minute') returning id into v_task;

    if pg_temp.raises(format('select public.submit_review(%L, %L, ''[]'', ''{}'', ''[]'', ''{}'', ''[]'', ''{}'')', v_task, v_user), 'lock_lost') then
      v_passed := v_passed + 1; v_results := v_results || 'PASS  submit_review refuses an expired hold (lock_lost)';
    else v_failed := v_failed + 1; v_results := v_results || 'FAIL  submit_review accepted an expired hold'; end if;

    update public.review_tasks set lock_expires_at = now() + interval '10 minutes' where id = v_task;
    update public.ingestion_records set status = 'needs_review' where id = v_rec3;
    if pg_temp.raises(format('select public.submit_review(%L, %L, ''[]'', ''{}'', ''[]'', ''{}'', ''[]'', ''{}'')', v_task, v_user), 'task_closed') then
      v_passed := v_passed + 1; v_results := v_results || 'PASS  submit_review refuses a record that is not in review (task_closed)';
    else v_failed := v_failed + 1; v_results := v_results || 'FAIL  submit_review accepted a record that is not in review'; end if;
    update public.ingestion_records set status = 'in_review' where id = v_rec3;

    perform public.reject_review(v_task, v_user, '[{"field_key":"diagnosis[0].text","action":"reject","original_value":"x","corrected_value":null,"original_code":null,"corrected_code":null,"source_span":null,"note":null}]'::jsonb, '{"rejected":1}'::jsonb);
    if (select status from public.ingestion_records where id = v_rec3) = 'rejected'
       and (select status from public.review_tasks where id = v_task) = 'completed'
       and (select count(*) from public.review_corrections where task_id = v_task) = 1
       and exists (select 1 from public.audit_log where record_id = v_rec3 and event = 'record.rejected') then
      v_passed := v_passed + 1; v_results := v_results || 'PASS  reject_review rejects the record, completes the task, stores the decisions and audits it';
    else v_failed := v_failed + 1; v_results := v_results || 'FAIL  reject_review did not leave the expected state'; end if;

    -- Lock expiry sweep.
    update public.ingestion_records set status = 'in_review' where id = v_rec3;
    update public.review_tasks set status = 'claimed', completed_at = null, lock_expires_at = now() - interval '1 minute' where id = v_task;
    if public.release_expired_review_locks() >= 1
       and (select status from public.review_tasks where id = v_task) = 'open'
       and (select status from public.ingestion_records where id = v_rec3) = 'needs_review' then
      v_passed := v_passed + 1; v_results := v_results || 'PASS  release_expired_review_locks reopens the task and returns the record to the queue';
    else v_failed := v_failed + 1; v_results := v_results || 'FAIL  expired lock was not released'; end if;
  else
    v_skipped := v_skipped + 3; v_results := v_results || 'SKIP  review function tests (3): no profile exists to act as reviewer';
  end if;

  -- ---------- 5. queue, spend ledger, source guard ----------
  insert into public.pipeline_jobs(record_id, stage) values (v_rec2, 'consent_check') returning id into v_job;
  select count(*) into v_count from public.claim_jobs(50, 'acceptance-worker') where id = v_job;
  if v_count = 1 and (select attempts from public.pipeline_jobs where id = v_job) = 1 and (select status from public.pipeline_jobs where id = v_job) = 'running' then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  claim_jobs claims a due job once and counts the attempt';
  else v_failed := v_failed + 1; v_results := v_results || 'FAIL  claim_jobs did not claim the job as expected'; end if;
  select count(*) into v_count from public.claim_jobs(50, 'another-worker') where id = v_job;
  if v_count = 0 then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  a second worker cannot claim a running job';
  else v_failed := v_failed + 1; v_results := v_results || 'FAIL  a running job was claimed twice'; end if;

  v_num := public.get_llm_spend();
  v_arr := public.add_llm_spend(1.5);
  if v_arr[1] = v_num and v_arr[2] = v_num + 1.5 and public.get_llm_spend() = v_num + 1.5 then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  add_llm_spend returns before and after totals and get_llm_spend agrees';
  else v_failed := v_failed + 1; v_results := v_results || 'FAIL  the spend ledger did not add up'; end if;

  if pg_temp.raises(format('update public.provider_sources set auto_commit_enabled = true where id = %L', v_src), 'chk_source_autocommit_requires_eval') then
    v_passed := v_passed + 1; v_results := v_results || 'PASS  a source cannot have auto-commit on until its evaluation passed';
  else v_failed := v_failed + 1; v_results := v_results || 'FAIL  auto-commit was enabled without a passed evaluation'; end if;

  -- ---------- 6. row level security: a viewer reads no PHI ----------
  begin
    v_viewer := gen_random_uuid();
    insert into auth.users(id, instance_id, aud, role, email)
      values (v_viewer, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer-' || v_viewer || '@example.test');
    insert into public.profiles(id, org_id, email, role, active)
      values (v_viewer, v_org, 'viewer-' || v_viewer || '@example.test', 'viewer', true);
    v_viewer_ok := true;
  exception when others then
    v_viewer_ok := false;
  end;

  if v_viewer_ok then
    perform set_config('request.jwt.claims', json_build_object('sub', v_viewer, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select (select count(*) from public.ingestion_records) + (select count(*) from public.fhir_resources)
         + (select count(*) from public.documents) + (select count(*) from public.extracted_fields) into v_count;
    reset role;
    if v_count = 0 then
      v_passed := v_passed + 1; v_results := v_results || 'PASS  a viewer reads no rows from records, resources, documents or fields';
    else v_failed := v_failed + 1; v_results := v_results || format('FAIL  a viewer could read %s PHI rows', v_count); end if;

    perform set_config('request.jwt.claims', json_build_object('sub', v_viewer, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into v_count from public.audit_log;
    reset role;
    if v_count = 0 then
      v_passed := v_passed + 1; v_results := v_results || 'PASS  a viewer cannot read the audit log';
    else v_failed := v_failed + 1; v_results := v_results || format('FAIL  a viewer could read %s audit rows', v_count); end if;
  else
    v_skipped := v_skipped + 2; v_results := v_results || 'SKIP  viewer row-level-security tests (2): auth.users could not be written from this role';
  end if;

  -- ---------- report (and roll everything back) ----------
  raise exception E'ACCEPTANCE RESULT: % passed, % failed, % skipped\n%', v_passed, v_failed, v_skipped, array_to_string(v_results, E'\n');
end $$;
