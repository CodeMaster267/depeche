-- Archived chats are kept. Archiving moves a chat out of the list on purpose, so the monthly
-- clean-up leaves it alone, the same as a pinned chat. Restoring it (or writing in it) brings it
-- back, and from then on the usual month without use applies again.

create or replace function public.expire_old_chats() returns integer
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
        and c.archived_at is null
        and c.updated_at < now() - interval '30 days';
    get diagnostics n = row_count;
    return n;
  end
  $$;
revoke all on function public.expire_old_chats() from public, anon, authenticated;
grant execute on function public.expire_old_chats() to service_role;
