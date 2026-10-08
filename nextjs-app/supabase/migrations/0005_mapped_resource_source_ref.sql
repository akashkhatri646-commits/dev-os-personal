-- Which extracted entity a mapped resource was built from (e.g. 'medication[0]', 'encounter').
-- Scoring uses it to find the fields that belong to each resource.
alter table public.mapped_resources add column if not exists source_ref text;
