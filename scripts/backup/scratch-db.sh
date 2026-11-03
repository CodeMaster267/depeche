#!/usr/bin/env bash
# Starts an empty, throwaway Supabase database (port 55432) to test a restore into, separate from
# the live one and from the usual local one. Prints its address.
set -euo pipefail
DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/depeche-restore-check"
mkdir -p "$DIR/supabase"
cat > "$DIR/supabase/config.toml" <<'TOML'
project_id = "depeche-restore-check"
[db]
port = 55432
shadow_port = 55430
major_version = 17
TOML
npx supabase db start --workdir "$DIR" >&2
echo "postgresql://postgres:postgres@127.0.0.1:55432/postgres"
