-- Editing a message and regenerating a reply both add a new message beside the old one (the same
-- parent), so a chat is a tree and the app can flip between versions. Nothing is ever changed or
-- removed. Now that people choose which message a new one follows, the database makes sure that
-- message is in the same chat and belongs to the same person, whoever writes the row.

create function public.messages_parent_check() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if new.parent_id is not null and not exists (
      select 1 from public.messages p
      where p.id = new.parent_id and p.chat_id = new.chat_id and p.owner_id = new.owner_id
    ) then
      raise exception 'A message must follow one in the same chat' using errcode = '23514';
    end if;
    return new;
  end
  $$;
revoke all on function public.messages_parent_check() from public, anon, authenticated;

create trigger messages_parent_check
  before insert on public.messages
  for each row execute function public.messages_parent_check();

-- Versions of a message are found by their shared parent.
create index if not exists messages_chat_parent_created_idx on public.messages (chat_id, parent_id, created_at);
