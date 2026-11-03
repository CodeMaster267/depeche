# Depeche

A private, invite-only AI chat app for a few families and friend groups.

## Status

Step 2 of 9 (foundation): app skeleton, database schema with per-person privacy rules, and tests that
prove them. Nothing is deployed yet.

## Running it

```sh
npm install
npm test          # database privacy tests (no setup needed)
npm run build && npm run test:e2e   # Chrome and Safari, desktop and phone
npm run dev       # http://localhost:3000
```

For the app to talk to Supabase, copy `.env.example` to `.env.local` and fill it in. Never commit real keys.

## Where things are

| Path | What |
| --- | --- |
| `supabase/migrations/` | Database schema and row-level security policies |
| `tests/db/` | Tests that try to break the privacy rules |
| `app/` | Next.js pages and styles (`globals.css` holds the design tokens) |
| `lib/supabase/` | Supabase clients for the browser and server |
| `CLAUDE.md` | The rules any code change must follow |
