# depeche-private

The private half of Depeche's automation. The app repo (CodeMaster267/depeche) is public, so
anything that must not be public runs in the private repo CodeMaster267/depeche-private:

- `backup.yml`: the nightly backup (unencrypted by Hasan's choice; its artifacts are only downloadable by Hasan).
- `bug-report-text.yml`: copies each bug report's text into a private issue.

These files are the source of truth for that repo; copy them there when they change. Secrets the
private repo needs: `SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
