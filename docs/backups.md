# Backups and keep-alive

## What runs, and when

| When | What | Where |
| --- | --- | --- |
| Every night, 03:17 UTC | Dump the live database and any Storage files, **restore into a separate empty database and check every table and file**, keep the file | `backup.yml` in the private repo CodeMaster267/depeche-private (copy at `ops/private-repo/`) |
| Every day, 15:41 UTC | Wake the app and database so Supabase's free plan never pauses; check a good backup happened in the last 36 hours, and open an issue if not | `.github/workflows/keep-alive.yml` |
| Every day (Vercel picks the minute in the 09:00 UTC hour) | Wake the database again, independently of GitHub | `vercel.json` → `/api/keep-alive` |

All of it is free: GitHub Actions minutes on a private repository (about 3 minutes a night) and
Vercel Hobby's daily cron.

**Where backups live.** Each night's file is a private artifact of that night's run
in the **private** repo CodeMaster267/depeche-private (GitHub → depeche-private → Actions → Nightly backup → a run → Artifacts). The app repo is public, so backups never run there. Each copy is kept 30 days, then GitHub deletes it.
Nothing older is kept, so a chat or memory someone deletes is gone from every backup within 30 days. Nothing is committed to git. Only people with access to the private repository can
download them.

**What a backup holds.** Supabase's own dump format (`roles.sql`, `schema.sql`, `data.sql`), so
`auth` (accounts and sign-in identities), `storage` (file metadata) and all Depeche tables; the list
of applied migrations; every Storage file once there are any; and `manifest.json` with row counts
and checksums.

**Alerts.** A failed or cancelled backup, a missing backup, or a database that doesn't answer opens
a GitHub issue that mentions Hasan, so GitHub emails him. The next good run closes it.

**Record.** Each verified backup adds a row to `public.backup_runs` (date, size, rows, files,
restore verified, link to the run). Each backup, restore test and keep-alive also writes a row to
`public.system_checks` (ok or not) for the Health screen, once that table exists.

## Secrets (GitHub → Settings → Secrets and variables → Actions)

These go in the **private** repo (depeche-private).

- `SUPABASE_DB_URL`: the live database (same value as in the app repo, where `database.yml` uses it).
- `SUPABASE_SERVICE_ROLE_KEY`: only once Depeche stores files. Until then it isn't needed; if files
  appear without it, the backup fails and the alert says so.

Backups are **not encrypted** since 2026-11-04 (Hasan's choice): they're protected by the private
repo's access instead. Encrypted backups from before then (`.tar.gz.gpg`) need the "Depeche backups"
password from Hasan's Apple Passwords as `BACKUP_PASSPHRASE`; `restore.sh` handles both.

## Restoring

Ask Claude to do it, or:

1. Download the artifact you want from the Actions tab of the private repo CodeMaster267/depeche-private and unzip it, giving
   `depeche-backup-<date>.tar.gz`.
2. Create a **new, empty** Supabase project (never restore over the live one) and copy its
   "Session pooler" connection string.
3. Run, with Docker running and `npm ci` done:

   ```sh
   scripts/backup/restore.sh depeche-backup-<date>.tar.gz 'postgresql://…new project…'
   ```

   To put Storage files back as well, also set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for
   the new project. The script restores everything, records the migrations, and checks every table's
   row count and every file's checksum against the backup. It stops on the first problem.
4. Point Vercel's `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and
   `SUPABASE_SERVICE_ROLE_KEY` (and the `SUPABASE_DB_URL` secret here) at the new project, and add
   the Google sign-in redirect URL for it.

Provider keys in the backup are still encrypted with the app's key (see README), so keep the same
`DEPECHE_ENCRYPTION_KEY` / Supabase secret key, or admins re-enter their provider keys.

To try a restore locally without touching anything live: `npm run db:start`, then
`scripts/backup/backup.sh out` with `DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`,
then `scripts/backup/restore.sh out/*.tar.gz "$(scripts/backup/scratch-db.sh)"`. CI does exactly this on every PR.
