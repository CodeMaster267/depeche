#!/usr/bin/env bash
# Restores an encrypted Depeche backup into an EMPTY Supabase database, then checks every table's
# row count and every Storage file against the backup's manifest.
#
#   BACKUP_PASSPHRASE=...  scripts/backup/restore.sh  depeche-backup-<date>.tar.gz.gpg  TARGET_DB_URL
#
# The nightly backup job runs exactly this against a throwaway local database, so the path used in
# an emergency is the one tested every night. To also put Storage files back into a real project,
# set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the TARGET project. Never point this at the
# live database: it expects an empty one.
#
# Set RESTORE_REPORT=path to save the check's JSON report.
set -euo pipefail

: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is not set}"
FILE="${1:?usage: restore.sh BACKUP_FILE TARGET_DB_URL}"
TARGET="${2:?usage: restore.sh BACKUP_FILE TARGET_DB_URL}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Decrypting $(basename "$FILE")"
gpg --batch --quiet --pinentry-mode loopback --decrypt \
    --passphrase-file <(printf '%s' "$BACKUP_PASSPHRASE") "$FILE" | tar -C "$WORK" -xzf -
D="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -n 1)"

echo "Restoring roles, schema and data"
node "$HERE/manifest.mjs" prune "$D"
psql "$TARGET" --quiet --single-transaction -v ON_ERROR_STOP=1 \
  --file "$D/roles.sql" \
  --file "$D/schema.sql" \
  --command 'SET session_replication_role = replica' \
  --file "$D/data-restore.sql" >/dev/null

# Record the migrations the backup had, so `supabase db push` on the restored project only applies newer ones.
VALUES="$(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const q = (s) => s == null ? "null" : "\x27" + String(s).replaceAll("\x27", "\x27\x27") + "\x27";
  console.log(m.map((r) => `(${q(r.version)}, ${q(r.name)})`).join(", "));
' "$D/migrations.json")"
if [ -n "$VALUES" ]; then
  psql "$TARGET" --quiet -v ON_ERROR_STOP=1 >/dev/null <<SQL
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values $VALUES on conflict (version) do nothing;
SQL
fi

echo "Checking the restore against the backup"
if [ -n "${RESTORE_REPORT:-}" ]; then
  node "$HERE/manifest.mjs" check "$D" "$TARGET" | tee "$RESTORE_REPORT"
else
  node "$HERE/manifest.mjs" check "$D" "$TARGET"
fi

if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] && [ -d "$D/files" ]; then
  node "$HERE/storage.mjs" upload "$D"
elif [ -d "$D/files" ]; then
  echo "Storage files are in the backup but were not uploaded (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the new project)."
fi
echo "Restore checked: OK"
