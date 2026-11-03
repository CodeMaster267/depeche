-- Chats delete themselves after a month without use, unless the person chose to keep their chats.
-- Pinned chats are always kept. The daily clean-up (server) runs `expire_old_chats`; deleting a chat
-- removes its messages too, and its files go in the same clean-up run.

alter table public.profiles add column keep_chats boolean not null default false;
grant update (keep_chats) on public.profiles to authenticated;

create function public.expire_old_chats() returns integer
  language plpgsql security definer set search_path = ''
  as $$
  declare
    n integer;
  begin
    delete from public.chats c
      using public.profiles p
      where p.id = c.owner_id
        and not p.keep_chats
        and not c.pinned
        and c.updated_at < now() - interval '30 days';
    get diagnostics n = row_count;
    return n;
  end
  $$;
revoke all on function public.expire_old_chats() from public, anon, authenticated;
grant execute on function public.expire_old_chats() to service_role;
