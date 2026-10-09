-- RESET TEST DATA: for a database that holds SYNTHETIC records only. It cannot be undone.
--
-- Removes everything the pipeline produced: records, uploaded-document rows, extracted fields, mapped resources,
-- scores, routing decisions, review tasks and corrections, committed FHIR resources and provenance, queued jobs,
-- consent checks, downstream-error reports, the AUDIT LOG, the daily model-spend counter and the rate-limit counters.
--
-- Keeps: organisations, users and profiles (you stay signed in), sources and their keys and thresholds, patients,
-- consent artifacts (your test consents), the terminology, knowledge documents and prompt versions.
--
-- Uploaded files in the storage bucket are NOT removed by SQL: delete them in the dashboard (Storage -> source-documents).
--
-- HOW TO RUN: paste into the Supabase SQL Editor of the project you want to reset. Change the word on the line
-- marked CONFIRM from 'NO' to 'WIPE-SYNTHETIC-DATA', then run. Without that change it stops and deletes nothing.
-- The audit log's protections are switched off for the delete and back on straight after, inside one transaction:
-- if anything fails, nothing is deleted and the protections stay on. The audit chain starts again from empty.

do $$
declare
  v_confirm text := 'NO';  -- CONFIRM: change 'NO' to 'WIPE-SYNTHETIC-DATA' to allow the delete
  v_records bigint;
  v_audit   bigint;
begin
  select count(*) into v_records from public.ingestion_records;
  select count(*) into v_audit from public.audit_log;

  if v_confirm <> 'WIPE-SYNTHETIC-DATA' then
    raise exception 'Nothing deleted. This would remove % records and % audit entries. Change v_confirm to WIPE-SYNTHETIC-DATA to proceed.', v_records, v_audit;
  end if;

  alter table public.audit_log disable trigger trg_audit_log_no_truncate;

  -- CASCADE also empties every table that points at a record (documents, fields, resources, scores, decisions,
  -- review tasks and corrections, FHIR resources, provenance, jobs, consent checks, downstream errors, audit log).
  truncate table public.ingestion_records, public.audit_log restart identity cascade;

  alter table public.audit_log enable trigger trg_audit_log_no_truncate;

  truncate table public.llm_spend_daily;
  truncate table public.rate_limit_events;

  raise notice 'Done: removed % records and % audit entries.', v_records, v_audit;
end $$;
