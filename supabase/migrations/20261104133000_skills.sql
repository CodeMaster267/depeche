-- Skills: packs of instructions (and optional text files) that a chat picks up by itself when a
-- message is about what the skill covers, like Claude's skills ("family-budget", "wedding-planning").
--
-- A model writes each skill from what the person describes, and the model chooses its name. Every
-- skill goes into one library that everyone with a Depeche profile can see, across all families
-- (Hasan, 2026-11-04). Each person chooses which library skills are theirs ("My skills"); only
-- those are ever used in their chats, and only in the chat they are used in. A skill is text, never
-- code, and it is given no way to reach anyone's memories or chats.
--
-- Who can do what:
--   * Read: anyone with a profile sees published skills; a maker also sees their own removed ones.
--   * Write, change: only the server (service role), after screening the skill for harmful,
--     sexual or prompt-injection content, both when it is made and every time it is changed.
--   * Delete: the maker, with their own session (gone for everyone who added it).
--   * Remove from the library: the app owner (any skill), or a family admin (skills made in their
--     family), through remove_skill() on the server.

create table public.skills (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references public.profiles (id) on delete cascade,
  family_id     uuid not null references public.families (id) on delete cascade,
  -- Chosen by the model, never typed by the person: lowercase words joined by hyphens.
  name          text not null unique check (char_length(name) between 3 and 40 and name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description   text not null check (char_length(description) between 1 and 300),
  instructions  text not null check (char_length(instructions) between 1 and 12000),
  -- Up to 4 text files the skill brings, [{name, content}], written with the skill.
  files         jsonb not null default '[]' check (jsonb_typeof(files) = 'array' and jsonb_array_length(files) <= 4 and octet_length(files::text) <= 40000),
  -- Words and phrases that make a chat pick the skill up.
  triggers      text[] not null default '{}' check (cardinality(triggers) <= 30),
  model         text check (model is null or char_length(model) <= 100),
  version       integer not null default 1 check (version >= 1),
  status        text not null default 'published' check (status in ('published', 'removed')),
  removed_by    uuid references public.profiles (id) on delete set null,
  removed_at    timestamptz,
  removed_note  text check (char_length(removed_note) <= 300),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index skills_owner_idx on public.skills (owner_id, created_at desc);
create index skills_library_idx on public.skills (updated_at desc) where status = 'published';

-- The family is always the maker's own, whatever the insert says.
create function public.skills_family() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    new.family_id := (select family_id from public.profiles where id = new.owner_id);
    return new;
  end
  $$;
revoke all on function public.skills_family() from public, anon, authenticated;
create trigger skills_family before insert or update of owner_id on public.skills
  for each row execute function public.skills_family();

-- The library skills each person has added ("My skills"). Only these are used in their chats.
create table public.skill_picks (
  owner_id  uuid not null references public.profiles (id) on delete cascade,
  skill_id  uuid not null references public.skills (id) on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (owner_id, skill_id)
);
create index skill_picks_skill_idx on public.skill_picks (skill_id);

-- At most 50 skills each.
create function public.skill_picks_cap() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if (select count(*) from public.skill_picks where owner_id = new.owner_id) >= 50 then
      raise exception 'You can have up to 50 skills. Remove one first' using errcode = 'P0001';
    end if;
    return new;
  end
  $$;
revoke all on function public.skill_picks_cap() from public, anon, authenticated;
create trigger skill_picks_cap before insert on public.skill_picks
  for each row execute function public.skill_picks_cap();

-- Supabase grants everything on new tables by default; take it back.
revoke all on public.skills, public.skill_picks from public, anon, authenticated;
grant select, delete on public.skills to authenticated;
grant select, insert, delete on public.skill_picks to authenticated;

alter table public.skills      enable row level security;
alter table public.skill_picks enable row level security;

-- An auth account without a profile sees nothing (see lib/auth/finish.ts).
create policy skills_select on public.skills for select to authenticated
  using (public.my_family_id() is not null and (status = 'published' or owner_id = auth.uid()));
create policy skills_delete on public.skills for delete to authenticated
  using (owner_id = auth.uid());

create policy skill_picks_select on public.skill_picks for select to authenticated
  using (owner_id = auth.uid());
create policy skill_picks_insert on public.skill_picks for insert to authenticated
  with check (
    owner_id = auth.uid()
    and exists (select 1 from public.skills s where s.id = skill_id and s.status = 'published')
  );
create policy skill_picks_delete on public.skill_picks for delete to authenticated
  using (owner_id = auth.uid());

-- Removing a skill from the library: the app owner can remove any; a family admin can remove the
-- ones made in their family. The maker still sees it (marked removed) and can delete it.
create function public.remove_skill(p_actor uuid, p_skill uuid, p_note text) returns void
  language plpgsql security definer set search_path = ''
  as $$
  declare
    actor public.profiles;
    fam uuid;
  begin
    select * into actor from public.profiles where id = p_actor;
    select family_id into fam from public.skills where id = p_skill;
    if fam is null then
      raise exception 'That skill doesn''t exist' using errcode = 'P0001';
    end if;
    if actor.id is null or not (actor.is_app_owner or (actor.role = 'admin' and actor.family_id = fam)) then
      raise exception 'Only the app owner, or an admin of the family that made it, can remove this skill' using errcode = 'P0001';
    end if;
    update public.skills
      set status = 'removed', removed_by = p_actor, removed_at = now(), removed_note = nullif(left(trim(coalesce(p_note, '')), 300), '')
      where id = p_skill;
  end
  $$;
revoke all on function public.remove_skill(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.remove_skill(uuid, uuid, text) to service_role;
