-- Projects: a person's own folders for chats, each with optional instructions and files that every
-- chat inside it gets. Private like chats: only the owner can see or change a project, its files, or
-- which chats are in it. A family admin who can see a member's chat titles sees which chats share a
-- project id, never the project's name, instructions or files.
--
-- A chat can only be put in a project of the same owner (the foreign key includes owner_id).
-- Deleting a project moves its chats back to the main list; they are not deleted.
--
-- Project files live in the same private uploads bucket, under the owner's folder. They are kept
-- for as long as the project has them (the 3-day clean-up skips them), and chats in a project are
-- kept from the monthly clean-up, the same as pinned and archived chats.

create table public.projects (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references public.profiles (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 100),
  instructions text not null default '' check (char_length(instructions) <= 8000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, owner_id)
);
create index projects_owner_idx on public.projects (owner_id, updated_at desc);

create table public.project_files (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null,
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  path        text not null check (char_length(path) < 300 and path not like '%..%'),
  name        text not null check (char_length(name) between 1 and 200),
  mime        text not null check (char_length(mime) <= 200),
  size        integer not null check (size > 0 and size <= 10485760),
  created_at  timestamptz not null default now(),
  foreign key (project_id, owner_id) references public.projects (id, owner_id) on delete cascade,
  -- Only ever a file in the owner's own folder.
  check (split_part(path, '/', 1) = owner_id::text),
  unique (project_id, path)
);
create index project_files_project_idx on public.project_files (project_id, created_at);

alter table public.chats add column project_id uuid;
alter table public.chats
  add constraint chats_project_fk foreign key (project_id, owner_id)
  references public.projects (id, owner_id) on delete set null (project_id);
create index chats_project_idx on public.chats (project_id, updated_at desc) where project_id is not null;

-- Supabase grants everything on new tables by default; take it back and grant only what's needed.
revoke all on public.projects, public.project_files from anon, authenticated;
grant select, insert, delete on public.projects to authenticated;
grant update (name, instructions, updated_at) on public.projects to authenticated;
grant select, insert, delete on public.project_files to authenticated;
grant update (project_id) on public.chats to authenticated;

alter table public.projects      enable row level security;
alter table public.project_files enable row level security;

-- Yours only. No admin read: a project's name and instructions are as private as a message.
create policy projects_select on public.projects for select to authenticated
  using (owner_id = auth.uid());
create policy projects_insert on public.projects for insert to authenticated
  with check (owner_id = auth.uid());
create policy projects_update on public.projects for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy projects_delete on public.projects for delete to authenticated
  using (owner_id = auth.uid());

create policy project_files_select on public.project_files for select to authenticated
  using (owner_id = auth.uid());
create policy project_files_insert on public.project_files for insert to authenticated
  with check (owner_id = auth.uid());
create policy project_files_delete on public.project_files for delete to authenticated
  using (owner_id = auth.uid());

-- Uploads due to be deleted: as before, but never a file a project still has.
create or replace function public.expired_uploads(p_limit int default 1000) returns setof text
  language sql stable security definer set search_path = ''
  as $$
    select o.name from storage.objects o
    where o.bucket_id = 'uploads'
      and o.created_at < now() - interval '1 day'
      and not exists (select 1 from public.project_files f where f.path = o.name)
      and not exists (
        select 1 from public.messages m join public.chats c on c.id = m.chat_id
        where c.updated_at > now() - interval '3 days'
          and m.content -> 'files' @> jsonb_build_array(jsonb_build_object('path', o.name))
      )
    order by o.created_at
    limit p_limit
  $$;
revoke all on function public.expired_uploads(int) from public, anon, authenticated;
grant execute on function public.expired_uploads(int) to service_role;

-- Chats a month unused are deleted, except pinned, archived and (now) those kept in a project.
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
        and c.project_id is null
        and c.updated_at < now() - interval '30 days';
    get diagnostics n = row_count;
    return n;
  end
  $$;
revoke all on function public.expire_old_chats() from public, anon, authenticated;
grant execute on function public.expire_old_chats() to service_role;
