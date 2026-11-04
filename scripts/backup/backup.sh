#!/usr/bin/env bash
# Makes one backup of the live Depeche database, plus any Supabase Storage files.
#
#   DB_URL=...  [BACKUP_PASSPHRASE=...]  scripts/backup/backup.sh  OUT_DIR
#
# Writes OUT_DIR/depeche-backup-<date>.tar.gz and prints its path as the last line. Hasan chose
# (2026-11-04) to keep backups unencrypted: they live only in the private repo
# CodeMaster267/depeche-private. If BACKUP_PASSPHRASE is set, the file is encrypted instead
# (AES-256, depeche-backup-<date>.tar.gz.gpg).
# Inside the file:
#   roles.sql, schema.sql, data.sql   Supabase's own dump format (auth, storage and public data)
#   migrations.json                   which migrations the database had, so `db push` works after a restore
#   storage-objects.json, files/      every Storage file and its metadata (once there are any)
#   manifest.json                     row counts per table and file checksums, checked by restore.sh
#
# Storage files need SUPABASE_SERVICE_ROLE_KEY (and SUPABASE_URL, which is worked out from DB_URL
# when it is a Supabase address). While there are no files, neither is needed.
set -euo pipefail

: "${DB_URL:?DB_URL is not set}"
BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:-}"
OUT_DIR="${1:?usage: backup.sh OUT_DIR}"
if [ -n "$BACKUP_PASSPHRASE" ] && [ "${#BACKUP_PASSPHRASE}" -lt 20 ]; then
  echo "BACKUP_PASSPHRASE is shorter than 20 characters. Use a long generated password." >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
STAMP="${BACKUP_STAMP:-$(date -u +%Y-%m-%d)}"
NAME="depeche-backup-$STAMP"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
D="$WORK/$NAME"
mkdir -p "$D" "$OUT_DIR"

echo "Dumping roles, schema and data"
npx supabase db dump --remote="$DB_URL" --role-only -f "$D/roles.sql"
npx supabase db dump --remote="$DB_URL" -f "$D/schema.sql"
npx supabase db dump --remote="$DB_URL" --data-only --use-copy -f "$D/data.sql"

# The dump leaves out Supabase's migration history; keep it so the restored database knows
# which migrations it already has.
has_table() { [ "$(psql "$DB_URL" -v ON_ERROR_STOP=1 -Atc "select to_regclass('$1') is not null")" = t ]; }

if has_table supabase_migrations.schema_migrations; then
  psql "$DB_URL" -v ON_ERROR_STOP=1 -Atc "
    select coalesce(json_agg(to_jsonb(m) - 'statements' order by m.version), '[]')
    from supabase_migrations.schema_migrations m" > "$D/migrations.json"
else
  echo '[]' > "$D/migrations.json"
fi

echo "Listing Storage files"
if has_table storage.objects; then
  psql "$DB_URL" -v ON_ERROR_STOP=1 -Atc "
    select coalesce(json_agg(json_build_object(
             'bucket', bucket_id, 'name', name, 'size', (metadata->>'size')::bigint,
             'mimetype', metadata->>'mimetype') order by bucket_id, name), '[]')
    from storage.objects" > "$D/storage-objects.json"
else
  echo '[]' > "$D/storage-objects.json"
fi

COUNT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).length)' "$D/storage-objects.json")"
if [ "$COUNT" -gt 0 ]; then
  echo "Downloading $COUNT Storage file(s)"
  node "$HERE/storage.mjs" download "$D"
else
  echo "No Storage files yet"
fi

node "$HERE/manifest.mjs" write "$D"

if [ -n "$BACKUP_PASSPHRASE" ]; then
  echo "Encrypting"
  OUT="$OUT_DIR/$NAME.tar.gz.gpg"
  tar -C "$WORK" -czf - "$NAME" \
    | gpg --batch --yes --quiet --pinentry-mode loopback --symmetric --cipher-algo AES256 \
          --s2k-digest-algo SHA512 --s2k-count 65011712 --compress-algo none \
          --passphrase-file <(printf '%s' "$BACKUP_PASSPHRASE") \
          -o "$OUT"
else
  OUT="$OUT_DIR/$NAME.tar.gz"
  tar -C "$WORK" -czf "$OUT" "$NAME"
fi

echo "Wrote $OUT ($(wc -c < "$OUT") bytes)"
echo "$OUT"
