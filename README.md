# Depeche

A private, invite-only AI chat app for a few families and friend groups.

## Status

Step 3 of 9 (sign-in and families): sign in with an email link or code, Google, or a username and
password; first-time owner setup; invite links; family page for admins (members, spending limits,
password resets); account page. Nothing is deployed yet.

## Running it

```sh
npm install
npm test            # database privacy tests (no setup needed)
npm run db:start    # local Supabase in Docker; writes .env.local
npm run build && npm run test:e2e   # Chrome and Safari, desktop and phone, real sign-in
npm run dev         # http://localhost:3000 (local emails: http://127.0.0.1:54324)
```

Never commit real keys. In production they live in Vercel's environment variables.

## Where things are

| Path | What |
| --- | --- |
| `supabase/migrations/` | Database schema and row-level security policies |
| `tests/db/` | Tests that try to break the privacy rules |
| `app/` | Next.js pages and styles (`globals.css` holds the design tokens) |
| `lib/supabase/` | Supabase clients for the browser, the signed-in server, and the service role |
| `lib/auth/` | Who is signed in, and turning a proven email into a profile (invite or owner setup) |
| `supabase/templates/` | The sign-in email (link plus code). Paste into Supabase → Authentication → Emails |
| `e2e/` | Browser tests against the local Supabase |
| `CLAUDE.md` | The rules any code change must follow |
