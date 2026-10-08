-- =====================================================================
-- 0004_mapped_resource_flags.sql - risk flags on mapped resources (spec 07 / spec 08)
-- Run once in the Supabase SQL Editor AFTER 0003_audit_functions.sql.
-- (Fresh projects get this column from docs/specs/supabase-schema.sql instead.)
-- =====================================================================

-- Machine-readable reasons a resource must not auto-commit, set by the mapping stage and read by
-- scoring: uncoded, range_value, unit_unmapped, phase_unstated, invalid_code_selection, ...
alter table public.mapped_resources
  add column if not exists flags text[] not null default '{}';
