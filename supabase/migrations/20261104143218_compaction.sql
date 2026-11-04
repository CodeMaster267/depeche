-- Auto-compaction: when a chat gets long, a cheap model summarises its older part so each new
-- message doesn't re-send (and re-pay for) the whole conversation.
--
-- Messages are never changed. A summary is its own row saying "this covers the chat up to and
-- including message X"; it is only used for a reply whose path passes through X, so branches never
-- mix. Summaries are message contents: only their owner can read them (never a family admin, never
-- the app owner). Making one costs money, so only the server writes them. The owner can discard one,
-- and can turn summaries off for a chat.

create table public.chat_summaries (
  id                  uuid primary key default gen_random_uuid(),
  chat_id             uuid not null references public.chats (id) on delete cascade,
  owner_id            uuid not null references public.profiles (id) on delete cascade,
  through_message_id  uuid not null references public.messages (id) on delete cascade,
  previous_id         uuid references public.chat_summaries (id) on delete set null,
  -- How many summaries in a row were built from a previous summary rather than the originals.
  generation          integer not null default 0 check (generation >= 0),
  summary             text not null check (char_length(summary) between 1 and 40000),
  facts               jsonb not null default '[]'::jsonb check (jsonb_typeof(facts) = 'array'),
  provider            text not null,
  model               text not null,
  input_tokens        integer not null default 0 check (input_tokens >= 0),
  output_tokens       integer not null default 0 check (output_tokens >= 0),
  cost_usd            numeric(12, 6) not null default 0 check (cost_usd >= 0),
  status              text not null default 'active' check (status in ('active', 'discarded')),
  created_at          timestamptz not null default now()
);
create index chat_summaries_chat_idx on public.chat_summaries (chat_id, created_at);
-- Two tabs or a retry never summarise the same point twice. A discarded one can be redone.
create unique index chat_summaries_once on public.chat_summaries (chat_id, through_message_id)
  where status = 'active';

-- Per chat: 'auto' (default) or 'off'.
alter table public.chats
  add column compaction text not null default 'auto' check (compaction in ('auto', 'off'));
grant update (compaction) on public.chats to authenticated;

revoke all on public.chat_summaries from anon, authenticated;
grant select on public.chat_summaries to authenticated;
alter table public.chat_summaries enable row level security;
create policy chat_summaries_select on public.chat_summaries for select to authenticated
  using (owner_id = auth.uid());

-- The only change a person can make: stop using one of their own summaries. It is kept for the record.
create function public.discard_chat_summary(p_id uuid) returns void
  language plpgsql security definer set search_path = ''
  as $$
  begin
    update public.chat_summaries set status = 'discarded'
      where id = p_id and owner_id = auth.uid();
    if not found then
      raise exception 'No such summary' using errcode = 'P0001';
    end if;
  end
  $$;
revoke all on function public.discard_chat_summary(uuid) from public, anon;
grant execute on function public.discard_chat_summary(uuid) to authenticated;
