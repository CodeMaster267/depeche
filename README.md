# Depeche

A private, invite-only AI chat app for a few families and friend groups.

## Status

Live at https://depai.vercel.app. Sign-in and families are done, and so is the chat: family admins
add OpenAI, Anthropic and Google keys (encrypted on the server), everyone picks a model and chats
with streaming replies that render Markdown, tables, code, LaTeX, Mermaid diagrams, images and
sources. Chats sync across devices, stay private to each person, and stop at each person's monthly
limit.

## Running it

```sh
npm install
npm test            # database privacy tests (no setup needed)
npm run db:start    # local Supabase in Docker; writes .env.local
npm run build && npm run test:e2e   # Chrome and Safari, desktop and phone, real sign-in
npm run dev         # http://localhost:3000 (local emails: http://127.0.0.1:54324)
```

Never commit real keys. In production they live in Vercel's environment variables.

Locally, `.env.local` sets `DEPECHE_FAKE_AI=1`, so replies come from a built-in stand-in and no
provider is called. Any key starting with `test-` is accepted. This never works on Vercel.

Provider keys are encrypted with AES-256-GCM. The encryption key is `DEPECHE_ENCRYPTION_KEY` if it
is set in Vercel, and otherwise derived from the Supabase secret key. Rotating the Supabase secret key
without setting `DEPECHE_ENCRYPTION_KEY` first means admins re-enter their provider keys.

## Where things are

| Path | What |
| --- | --- |
| `supabase/migrations/` | Database schema and row-level security policies |
| `tests/db/` | Tests that try to break the privacy rules |
| `app/` | Next.js pages and styles (`globals.css` holds the design tokens) |
| `lib/supabase/` | Supabase clients for the browser, the signed-in server, and the service role |
| `lib/auth/` | Who is signed in, and turning a proven email into a profile (invite or owner setup) |
| `supabase/templates/` | The sign-in email (link plus code). Paste into Supabase → Authentication → Emails |
| `lib/ai/` | The model list with prices, and streaming from each provider |
| `app/api/chat/` | Sends a message and streams the reply; saves the reply and its cost |
| `components/chat/`, `components/markdown/` | The chat screen, and how replies are rendered |
| `e2e/` | Browser tests against the local Supabase |
| `scripts/backup/`, `docs/backups.md` | Nightly encrypted backups with a restore test, and the keep-alive that stops Supabase pausing |
| `app/report/` | Report a bug (each person sees only their own reports) |
| `scripts/bugs/`, `.github/workflows/bug-fix*.yml` | The daily bug fixer and the rules for what it may change and merge |
| `CLAUDE.md` | The rules any code change must follow |
