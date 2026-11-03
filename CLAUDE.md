# Depeche: notes for Claude Code

Depeche is a private, invite-only AI chat app for a few families and friend groups (under 30 people).
The owner is **Hasan**; refer to them by that name. The full product decisions live in the
"Depeche — Build Decisions" doc (https://claude.ai/artifact/FLJK99skReRRurDzzcdgTH). This file is the
short version that matters when writing code.

## Non-negotiables

- **Privacy is enforced in Postgres, not the UI.** Every person-owned row carries `owner_id`, and
  row-level security decides who sees it. Never "filter in the app" as a substitute.
  - Members see only their own chats, messages, memories and usage.
  - A family admin also sees members' chat **titles** and **usage**, never message contents or memories.
  - The app owner is just an admin of their own family who can also create families and invite
    their first admin. The owner sees **nothing** inside another family.
- **Anything that costs money or changes trust goes through the server** (service role): assistant
  messages, usage records, provider keys, roles, caps, invites being accepted. The browser cannot
  write those tables; tests prove it.
- **Provider keys** are encrypted with AES-256-GCM by the server before storage. The encryption key
  lives in Vercel env vars. No signed-in user can read `ciphertext`; admins see `last4` only.
- **Messages are append-only.** Edits create a new message with `parent_id`; originals are kept.
  Compaction summaries will live in their own table and never replace messages.
- **Sends are idempotent** via `(owner_id, client_request_id)`.
- **Never execute model output** (HTML/JS) in the app origin. Future artifacts go in a sandbox on a
  separate origin.
- **$0 infrastructure.** Do not add paid services or features that need them without Hasan's explicit OK.

## Stack

Next.js (App Router, TypeScript) on Vercel Hobby · Supabase Postgres + Auth · Tailwind v4 with
tokens in `app/globals.css` · Vitest. Pin exact dependency versions (`.npmrc` has `save-exact`).

## Design

Strict black and white, no accent colour. Archivo (900, 125% width) for the wordmark only, Geist for
everything else. The glitch (red/cyan channel split plus displaced slices) appears only on the
sign-in title card, the streaming indicator and transitions, never on text people read, and is off
under reduced motion. Mockups: `/mnt/project-files/depeche/screens/` in the project.

## Working here

- `npm test` runs the database privacy suite against an in-memory Postgres (PGlite) set up like
  Supabase, including Supabase's permissive default grants, then applies `supabase/migrations/`.
  Any schema change needs matching tests in `tests/db/`.
- `npm run typecheck`, `npm run build` must pass. CI runs all three on every PR.
- **Test every UI change in Chrome and Safari.** `npm run test:e2e` runs Playwright against
  Chromium and WebKit, each on desktop and on a phone (Pixel 7, iPhone 15). Report both results.
  Claude's cloud container has only Chromium (WebKit cannot be downloaded there), so locally run
  `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright test --project=chrome-desktop --project=chrome-android`
  and read the WebKit result from the CI `e2e` job. Say which browser ran where.
- Migrations are forward-only SQL files in `supabase/migrations/`, named by timestamp.
