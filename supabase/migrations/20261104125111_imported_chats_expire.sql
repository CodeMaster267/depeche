-- Imported chats now follow the same monthly clean-up as every other chat (Hasan's choice,
-- 2026-11-04), counted from the day they were imported rather than their original dates, which
-- would otherwise delete most of an import the next morning. Importing sets `kept_at`, which
-- restarts a chat's month without moving it in the list. Pinning, "Keep all my chats" and the
-- "about to be deleted" notice work for them as for any chat.

-- Chats already imported get a month from now.
update public.chats set kept_at = now() where imported_from is not null and kept_at is null;

create function public.imported_chat_kept() returns trigger
  language plpgsql set search_path = ''
  as $$
  begin
    if new.imported_from is not null then
      new.kept_at := coalesce(new.kept_at, now());
    end if;
    return new;
  end
  $$;
revoke all on function public.imported_chat_kept() from public, anon, authenticated;

create trigger chats_imported_kept
  before insert on public.chats
  for each row execute function public.imported_chat_kept();

-- The same rule in both functions, as before, without the exception for imported chats.
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
        and greatest(c.updated_at, coalesce(c.kept_at, c.updated_at)) < now() - interval '30 days';
    get diagnostics n = row_count;
    return n;
  end
  $$;
revoke all on function public.expire_old_chats() from public, anon, authenticated;
grant execute on function public.expire_old_chats() to service_role;

create or replace function public.my_expiring_chats(p_days integer default 3)
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
       and greatest(c.updated_at, coalesce(c.kept_at, c.updated_at))
           < now() - interval '30 days' + make_interval(days => least(greatest(p_days, 0), 30))
     order by 4
     limit 50
  $$;
revoke all on function public.my_expiring_chats(integer) from public, anon;
grant execute on function public.my_expiring_chats(integer) to authenticated;
