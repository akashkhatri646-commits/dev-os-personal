-- Source evaluation from reviewer decisions (docs/specs/17-source-evaluation.md).
-- Records what kind of data an evaluation was run on, so "passed on synthetic data" is never shown as "passed".
-- Safe to run again.

alter table public.eval_runs
  add column if not exists basis text check (basis in ('synthetic', 'real'));

alter table public.provider_sources
  add column if not exists eval_basis text check (eval_basis in ('synthetic', 'real'));
