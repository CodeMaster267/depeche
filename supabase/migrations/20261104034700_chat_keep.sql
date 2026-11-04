-- Chats about to be deleted. Each day, anyone with chats due for the monthly clean-up within the
-- next three days is told in the app and can keep them. Keeping a chat restarts its month without
-- moving it in the list (kept_at, not updated_at). The rule below must match expire_old_chats.

alter table public.chats add column kept_at timestamptz;
grant update (kept_at) on public.chats to authenticated;

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
        and c.imported_from is null
        and greatest(c.updated_at, coalesce(c.kept_at, c.updated_at)) < now() - interval '30 days';
    get diagnostics n = row_count;
    return n;
  end
  $$;
revoke all on function public.expire_old_chats() from public, anon, authenticated;
grant execute on function public.expire_old_chats() to service_role;

-- Your own chats the clean-up will delete within p_days days, soonest first. Runs as you, so
-- row-level security applies as well as the owner check.
create function public.my_expiring_chats(p_days integer default 3)
  returns table (id uuid, title text, archived boolean, deletes_at timestamptz)
  language sql stable security invoker set search_path = ''
  as $$
    select c.id, c.title, c.archived_at is not null,
           greatest(c.updated_at, coalesce(c.kept_at, c.updated_at)) + interval '30 days'
      from public.chats c
      join public.profiles p on p.id = c.owner_id
     where c.owner_id = auth.uid()
       and not p.keep_chats
       and not c.pinned
       and c.imported_from is null
       and greatest(c.updated_at, coalesce(c.kept_at, c.updated_at))
           < now() - interval '30 days' + make_interval(days => least(greatest(p_days, 0), 30))
     order by 4
     limit 50
  $$;
revoke all on function public.my_expiring_chats(integer) from public, anon;
grant execute on function public.my_expiring_chats(integer) to authenticated;
