#!/usr/bin/env bash
# Writes one row to public.system_checks (shown on the Health screen) through DB_URL.
#   scripts/backup/record-check.sh KIND true|false "detail"
# KIND is backup, restore_test, keep_alive or health_check. Never fails the job: if the database
# can't be reached or the table isn't there yet, it says so and carries on.
KIND="$1"; OK="$2"; DETAIL="${3:-}"
if [ -z "${DB_URL:-}" ]; then echo "No DB_URL, so no Health record."; exit 0; fi
psql "$DB_URL" -v ON_ERROR_STOP=1 --quiet -v kind="$KIND" -v ok="$OK" -v detail="$DETAIL" <<'SQL' \
  || echo "::warning::Could not record the $KIND check on the Health screen."
select to_regclass('public.system_checks') is not null as ready \gset
\if :ready
insert into public.system_checks (kind, ok, detail) values (:'kind', :'ok'::boolean, :'detail');
\endif
SQL
exit 0
