-- Canvas: a document or piece of code beside the chat that the person and the AI both edit.
--
-- A canvas belongs to one chat and one person, and is private to them like their messages: a
-- family admin and the app owner see nothing, not even the title. Its text lives in versions,
-- which are append-only like messages: every save by the person, and every rewrite by the AI, is a
-- new row, so nothing written is ever lost and any older version can be restored (as a new one).
--
-- The AI's versions come from its replies and are written by the server (service role). The
-- browser may only add the person's own versions to the person's own canvases.

create table public.canvases (
  id          uuid primary key default gen_random_uuid(),
  chat_id     uuid not null references public.chats (id) on delete cascade,
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 120),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index canvases_chat_idx on public.canvases (chat_id, updated_at desc);
create unique index canvases_chat_title_idx on public.canvases (chat_id, lower(title));

create table public.canvas_versions (
  id          uuid primary key default gen_random_uuid(),
  canvas_id   uuid not null references public.canvases (id) on delete cascade,
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  content     text not null check (char_length(content) <= 200000),
  author      text not null check (author in ('person', 'assistant')),
  -- The reply that wrote it (the AI's versions only).
  message_id  uuid references public.messages (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index canvas_versions_canvas_idx on public.canvas_versions (canvas_id, created_at);

revoke all on public.canvases, public.canvas_versions from anon, authenticated;
grant select on public.canvases to authenticated;
grant select, insert on public.canvas_versions to authenticated;

alter table public.canvases enable row level security;
alter table public.canvas_versions enable row level security;

-- Yours only. Admins and the app owner get nothing here.
create policy canvases_select on public.canvases for select to authenticated
  using (owner_id = auth.uid());
create policy canvas_versions_select on public.canvas_versions for select to authenticated
  using (owner_id = auth.uid());
-- The person's own edits, into their own canvas. The AI's versions come only from the server.
create policy canvas_versions_insert on public.canvas_versions for insert to authenticated
  with check (
    owner_id = auth.uid()
    and author = 'person'
    and message_id is null
    and exists (select 1 from public.canvases c where c.id = canvas_id and c.owner_id = auth.uid())
  );

-- A new version marks the canvas, and its chat, as just used (so the chat isn't auto-deleted
-- while someone is still working on its canvas).
create function public.canvas_version_touch() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  declare
    chat uuid;
  begin
    update public.canvases set updated_at = new.created_at where id = new.canvas_id
      returning chat_id into chat;
    update public.chats set updated_at = greatest(updated_at, new.created_at) where id = chat;
    return new;
  end
  $$;
revoke all on function public.canvas_version_touch() from public, anon, authenticated;
create trigger canvas_versions_touch after insert on public.canvas_versions
  for each row execute function public.canvas_version_touch();
