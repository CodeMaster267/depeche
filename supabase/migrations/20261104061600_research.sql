-- Deep research: the model plans a few research questions, searches the web for each, then writes
-- a long cited report. That takes several minutes, longer than one Vercel Hobby function may run,
-- so the work is split into steps and its progress is kept here between them.
--
-- The finished report is an ordinary assistant message (append-only, like every reply). This table
-- only holds the work in progress: the plan, the notes gathered so far, and what has been spent.
--
-- Only the server writes it. The person can read their own runs (to show progress); nobody else can,
-- not even their family admin or the app owner, because the plan and notes are about what they asked.

create table public.research_runs (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references public.profiles (id) on delete cascade,
  chat_id       uuid not null references public.chats (id) on delete cascade,
  question_id   uuid not null references public.messages (id) on delete cascade,
  model         text not null check (char_length(model) between 1 and 100),
  status        text not null default 'running' check (status in ('running', 'done', 'failed', 'stopped')),
  -- planning, researching, writing: what the run is doing now (or did last).
  phase         text not null default 'planning' check (phase in ('planning', 'researching', 'writing')),
  -- The last few messages before the question, so a follow-up in a chat makes sense.
  context       text not null default '' check (char_length(context) <= 20000),
  -- The person's own instructions ("About you", "How should Depeche answer"), as given to the model.
  instructions  text not null default '' check (char_length(instructions) <= 5000),
  title         text check (title is null or char_length(title) <= 200),
  questions     jsonb not null default '[]'::jsonb,
  notes         jsonb not null default '[]'::jsonb,
  sources       jsonb not null default '[]'::jsonb,
  draft         text not null default '',
  -- How many times a report cut short by the time limit has been continued.
  continuations integer not null default 0 check (continuations >= 0),
  notices       jsonb not null default '[]'::jsonb,
  searches      integer not null default 0 check (searches >= 0),
  cost_usd      numeric(12, 6) not null default 0 check (cost_usd >= 0),
  error         text check (error is null or char_length(error) <= 1000),
  -- One step runs at a time: a step claims the run until this time.
  lease_until   timestamptz,
  report_id     uuid references public.messages (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index research_runs_chat_idx on public.research_runs (chat_id, created_at);
create index research_runs_owner_idx on public.research_runs (owner_id, created_at desc);

revoke all on public.research_runs from public, anon, authenticated;
grant select on public.research_runs to authenticated;
grant all on public.research_runs to service_role;

alter table public.research_runs enable row level security;

-- Yours only. No insert, update or delete from the browser (no grants, no policies).
create policy research_runs_select on public.research_runs for select to authenticated
  using (owner_id = auth.uid());
