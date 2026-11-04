-- Saved assistants: a name, instructions, an optional model and files, that start chats set up a
-- certain way ("Homework helper", "Urdu tutor"). Private to their maker unless the maker shares
-- one with their family; then everyone in the family can see it and chat with it, and only the
-- maker can change it. Chats with an assistant stay private to whoever is chatting, as always.
--
-- The family is taken from the maker's profile when the assistant is made (never from the
-- browser), so an assistant can only ever be shared inside its maker's own family.

create table public.assistants (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references public.profiles (id) on delete cascade,
  family_id    uuid not null references public.families (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 60),
  description  text not null default '' check (char_length(description) <= 200),
  instructions text not null default '' check (char_length(instructions) <= 8000),
  model        text check (model is null or char_length(model) between 1 and 100),
  shared       boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, owner_id)
);
create index assistants_owner_idx on public.assistants (owner_id, updated_at desc);
create index assistants_family_idx on public.assistants (family_id) where shared;

create function public.assistants_family() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    new.family_id := (select family_id from public.profiles where id = new.owner_id);
    return new;
  end
  $$;
revoke all on function public.assistants_family() from public, anon, authenticated;
create trigger assistants_family before insert on public.assistants
  for each row execute function public.assistants_family();

create table public.assistant_files (
  id            uuid primary key default gen_random_uuid(),
  assistant_id  uuid not null,
  owner_id      uuid not null references public.profiles (id) on delete cascade,
  path          text not null check (char_length(path) < 300 and path not like '%..%'),
  name          text not null check (char_length(name) between 1 and 200),
  mime          text not null check (char_length(mime) <= 200),
  size          integer not null check (size > 0 and size <= 10485760),
  created_at    timestamptz not null default now(),
  foreign key (assistant_id, owner_id) references public.assistants (id, owner_id) on delete cascade,
  check (split_part(path, '/', 1) = owner_id::text),
  unique (assistant_id, path)
);
create index assistant_files_assistant_idx on public.assistant_files (assistant_id, created_at);

-- Which assistant a chat was started with. Anyone who can see an assistant can chat with it; the
-- server checks again on every message, so a chat with one that is no longer shared just carries on
-- without it.
alter table public.chats add column assistant_id uuid references public.assistants (id) on delete set null;

revoke all on public.assistants, public.assistant_files from anon, authenticated;
grant select, insert, delete on public.assistants to authenticated;
grant update (name, description, instructions, model, shared, updated_at) on public.assistants to authenticated;
grant select, insert, delete on public.assistant_files to authenticated;

alter table public.assistants      enable row level security;
alter table public.assistant_files enable row level security;

create policy assistants_select on public.assistants for select to authenticated
  using (owner_id = auth.uid() or (shared and family_id = public.my_family_id()));
create policy assistants_insert on public.assistants for insert to authenticated
  with check (owner_id = auth.uid());
create policy assistants_update on public.assistants for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy assistants_delete on public.assistants for delete to authenticated
  using (owner_id = auth.uid());

-- A shared assistant's file list is visible to the family (to show what it knows). The files
-- themselves stay in the maker's private folder; only the server reads them, for the model.
create policy assistant_files_select on public.assistant_files for select to authenticated
  using (
    owner_id = auth.uid()
    or exists (
      select 1 from public.assistants a
      where a.id = assistant_id and a.shared and a.family_id = public.my_family_id()
    )
  );
create policy assistant_files_insert on public.assistant_files for insert to authenticated
  with check (owner_id = auth.uid());
create policy assistant_files_delete on public.assistant_files for delete to authenticated
  using (owner_id = auth.uid());

-- Uploads due to be deleted: never a file a project or an assistant still has.
create or replace function public.expired_uploads(p_limit int default 1000) returns setof text
  language sql stable security definer set search_path = ''
  as $$
    select o.name from storage.objects o
    where o.bucket_id = 'uploads'
      and o.created_at < now() - interval '1 day'
      and not exists (select 1 from public.project_files f where f.path = o.name)
      and not exists (select 1 from public.assistant_files f where f.path = o.name)
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
