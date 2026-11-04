-- Sharing a chat: a read-only copy of one chat, frozen at the moment it was shared, opened with an
-- unguessable link. Sharing is opt-in per chat and only the chat's owner can do it.
--
-- * The copy is made by the server from the owner's own messages (read with their session), so the
--   browser can never write a share or put words into one. File attachments are named only: their
--   contents and storage paths are never copied.
-- * The owner can see their own shares (to copy the link again) and delete them, which stops the
--   link working at once. Nobody else, not even their family admin, can list or read share rows.
-- * Opening a link goes through `shared_chat(token)`, which returns exactly one share and only when
--   given its token. Without a token there is no way to list or find shares.
-- * Deleting the chat (by hand or by the monthly auto-delete) deletes its share too.

create table public.chat_shares (
  id          uuid primary key default gen_random_uuid(),
  token       text not null unique check (token ~ '^[A-Za-z0-9_-]{32,64}$'),
  chat_id     uuid not null unique references public.chats (id) on delete cascade,
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 200),
  messages    jsonb not null check (jsonb_typeof(messages) = 'array'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index chat_shares_owner_idx on public.chat_shares (owner_id);

-- A share always belongs to the person who owns the chat.
create function public.chat_share_owner_check() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if not exists (select 1 from public.chats c where c.id = new.chat_id and c.owner_id = new.owner_id) then
      raise exception 'Only the chat''s owner can share it' using errcode = 'P0001';
    end if;
    return new;
  end
  $$;
revoke all on function public.chat_share_owner_check() from public, anon, authenticated;
create trigger chat_shares_owner before insert or update on public.chat_shares
  for each row execute function public.chat_share_owner_check();

revoke all on public.chat_shares from anon, authenticated;
grant select (id, token, chat_id, created_at, updated_at) on public.chat_shares to authenticated;
grant delete on public.chat_shares to authenticated;

alter table public.chat_shares enable row level security;
create policy chat_shares_select on public.chat_shares for select to authenticated
  using (owner_id = auth.uid());
create policy chat_shares_delete on public.chat_shares for delete to authenticated
  using (owner_id = auth.uid());

-- One shared chat, by its link's token. Anyone holding the link may read it, signed in or not.
create function public.shared_chat(p_token text)
  returns table (title text, messages jsonb, updated_at timestamptz)
  language sql stable security definer set search_path = ''
  as $$
    select s.title, s.messages, s.updated_at from public.chat_shares s
    where p_token ~ '^[A-Za-z0-9_-]{32,64}$' and s.token = p_token
  $$;
revoke all on function public.shared_chat(text) from public;
grant execute on function public.shared_chat(text) to anon, authenticated, service_role;
