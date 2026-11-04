-- Smart memory: before a fact is remembered, it's checked against the person's other memories.
--   * `about` says who the fact is about, from the person's own point of view ("me", "dad",
--     "brother Ali"), so a fact about one person is never mixed up with another.
--   * When a new fact replaces older ones (an update, or the person picks the new one in a
--     conflict), the older ones are archived, not deleted, with `replaced_by` pointing at the new
--     one, so the change can be undone.
-- Still yours alone: the existing row-level security on memories applies to both columns.

alter table public.memories
  add column about       text check (about is null or char_length(about) between 1 and 80),
  add column replaced_by uuid references public.memories (id) on delete set null;

create index memories_replaced_by_idx on public.memories (replaced_by) where replaced_by is not null;

grant update (about, replaced_by) on public.memories to authenticated;

-- A memory can only be replaced by another memory of the same person.
create function public.memories_same_owner_replacement() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.replaced_by is not null and not exists (
    select 1 from public.memories m where m.id = new.replaced_by and m.owner_id = new.owner_id
  ) then
    raise exception 'A memory can only be replaced by one of your own';
  end if;
  return new;
end $$;
revoke all on function public.memories_same_owner_replacement() from public, anon, authenticated;

create trigger memories_same_owner_replacement
  before insert or update of replaced_by on public.memories
  for each row execute function public.memories_same_owner_replacement();
