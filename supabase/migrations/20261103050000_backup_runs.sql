-- One row per nightly backup, written by the backup job in GitHub Actions (as `postgres`, over
-- SUPABASE_DB_URL). It records when the backup ran, how big it was and whether the restore test
-- passed, so a future Health screen can show "last verified backup" without asking GitHub.
--
-- It holds no family data. Nobody signed in can read or write it yet: a Health screen that shows
-- it to the app owner must add its own policy (and tests).

create table public.backup_runs (
  id                uuid primary key default gen_random_uuid(),
  backup_name       text not null,                 -- e.g. depeche-backup-2026-11-04
  started_at        timestamptz not null,
  finished_at       timestamptz not null default now(),
  size_bytes        bigint not null check (size_bytes >= 0),
  tables            integer not null check (tables >= 0),
  rows              bigint not null check (rows >= 0),
  files             integer not null default 0 check (files >= 0),
  restore_verified  boolean not null,
  run_url           text
);
create index backup_runs_finished_idx on public.backup_runs (finished_at desc);

alter table public.backup_runs enable row level security;
revoke all on table public.backup_runs from public, anon, authenticated;
