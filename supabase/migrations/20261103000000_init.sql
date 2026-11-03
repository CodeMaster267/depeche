-- Depeche initial schema.
--
-- Privacy model (see docs/decisions.md, "Accounts, families and privacy"):
--   * Every person belongs to exactly one family.
--   * A person's chats, messages and memories are readable only by that person.
--   * A family admin can also read their members' chat titles and usage, never message contents.
--   * The app owner is an admin of their own family who can additionally create families
--     and invite those families' first admins. The owner sees nothing inside any other family.
--   * Provider keys are stored encrypted and are never readable by any signed-in user;
--     admins can see only the last four characters.
--   * Anything that costs money or changes roles and caps goes through the server
--     (service role), never directly from the browser.
--
-- Supabase grants broad table privileges to `anon` and `authenticated` by default, so this
-- migration revokes them and grants back only what each table needs. Row-level security
-- then limits which rows those privileges apply to.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.families (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 80),
  created_by  uuid not null references auth.users (id) on delete restrict,
  created_at  timestamptz not null default now()
);

create type public.member_role as enum ('member', 'admin');

create table public.profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  family_id        uuid not null references public.families (id) on delete restrict,
  role             public.member_role not null default 'member',
  is_app_owner     boolean not null default false,
  display_name     text not null check (char_length(display_name) between 1 and 60),
  username         text unique check (username ~ '^[a-z0-9_.-]{3,32}$'),
  monthly_cap_usd  numeric(10, 2) not null default 10.00 check (monthly_cap_usd >= 0),
  created_at       timestamptz not null default now()
);
create index profiles_family_idx on public.profiles (family_id);

create table public.invites (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families (id) on delete cascade,
  email        text not null check (email = lower(email) and email like '%_@_%'),
  role         public.member_role not null default 'member',
  invited_by   uuid not null references public.profiles (id) on delete cascade,
  token_hash   text not null unique,
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index invites_family_idx on public.invites (family_id);

create table public.provider_keys (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families (id) on delete cascade,
  provider    text not null check (provider in ('openai', 'anthropic', 'google', 'xai', 'deepseek')),
  ciphertext  bytea not null,          -- AES-256-GCM, encrypted by the server; the key lives in env, not here
  last4       text not null check (char_length(last4) = 4),
  created_by  uuid not null references public.profiles (id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (family_id, provider)
);

create table public.chats (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references public.profiles (id) on delete cascade,
  title        text not null default 'New chat' check (char_length(title) between 1 and 200),
  model        text,
  pinned       boolean not null default false,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index chats_owner_idx on public.chats (owner_id, updated_at desc);

-- Messages are append-only. Editing a message writes a new row whose parent is the
-- message it branches from, so the original is always kept.
create table public.messages (
  id                 uuid primary key default gen_random_uuid(),
  chat_id            uuid not null references public.chats (id) on delete cascade,
  owner_id           uuid not null references public.profiles (id) on delete cascade,
  parent_id          uuid references public.messages (id) on delete cascade,
  role               text not null check (role in ('user', 'assistant', 'system')),
  content            jsonb not null,  -- canonical, provider-neutral parts
  status             text not null default 'completed'
                     check (status in ('pending', 'streaming', 'completed', 'failed', 'stopped')),
  provider           text,
  model              text,
  client_request_id  uuid,            -- idempotency: a retried send cannot create a second message
  created_at         timestamptz not null default now(),
  unique (owner_id, client_request_id)
);
create index messages_chat_idx on public.messages (chat_id, created_at);

create table public.memories (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.profiles (id) on delete cascade,
  content            text not null check (char_length(content) between 1 and 2000),
  status             text not null default 'suggested'
                     check (status in ('suggested', 'active', 'rejected', 'archived')),
  source_message_id  uuid references public.messages (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index memories_owner_idx on public.memories (owner_id, status);

create table public.usage_events (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references public.profiles (id) on delete cascade,
  message_id     uuid references public.messages (id) on delete set null,
  provider       text not null,
  model          text not null,
  input_tokens   integer not null check (input_tokens >= 0),
  output_tokens  integer not null check (output_tokens >= 0),
  cost_usd       numeric(12, 6) not null check (cost_usd >= 0),  -- an estimate, not the provider's bill
  created_at     timestamptz not null default now()
);
create index usage_owner_month_idx on public.usage_events (owner_id, created_at);

-- ---------------------------------------------------------------------------
-- Helpers. SECURITY DEFINER so policies on profiles can call them without recursing.
-- ---------------------------------------------------------------------------

create function public.my_family_id() returns uuid
  language sql stable security definer set search_path = ''
  as $$ select family_id from public.profiles where id = auth.uid() $$;

create function public.is_family_admin() returns boolean
  language sql stable security definer set search_path = ''
  as $$ select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false) $$;

create function public.is_app_owner() returns boolean
  language sql stable security definer set search_path = ''
  as $$ select coalesce((select is_app_owner from public.profiles where id = auth.uid()), false) $$;

-- True when `person` is in the caller's family and the caller is that family's admin.
create function public.i_admin(person uuid) returns boolean
  language sql stable security definer set search_path = ''
  as $$
    select exists (
      select 1
      from public.profiles me
      join public.profiles them on them.family_id = me.family_id
      where me.id = auth.uid() and me.role = 'admin' and them.id = person
    )
  $$;

revoke all on function public.my_family_id(), public.is_family_admin(), public.is_app_owner(), public.i_admin(uuid) from public;
grant execute on function public.my_family_id(), public.is_family_admin(), public.is_app_owner(), public.i_admin(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Privileges: start from nothing, then grant only what the browser may do.
-- ---------------------------------------------------------------------------

revoke all on public.families, public.profiles, public.invites, public.provider_keys,
              public.chats, public.messages, public.memories, public.usage_events
  from anon, authenticated;

grant select                                   on public.families      to authenticated;
grant update (name)                            on public.families      to authenticated;
grant select                                   on public.profiles      to authenticated;
grant update (display_name)                    on public.profiles      to authenticated;
grant select (id, family_id, email, role, invited_by, expires_at, accepted_at, created_at)
                                               on public.invites       to authenticated;
grant select (id, family_id, provider, last4, created_at, updated_at)
                                               on public.provider_keys to authenticated;
grant select, insert, delete                   on public.chats         to authenticated;
grant update (title, model, pinned, archived_at, updated_at)
                                               on public.chats         to authenticated;
grant select, insert                           on public.messages      to authenticated;
grant select, insert, delete                   on public.memories      to authenticated;
grant update (content, status, updated_at)     on public.memories      to authenticated;
grant select                                   on public.usage_events  to authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.families      enable row level security;
alter table public.profiles      enable row level security;
alter table public.invites       enable row level security;
alter table public.provider_keys enable row level security;
alter table public.chats         enable row level security;
alter table public.messages      enable row level security;
alter table public.memories      enable row level security;
alter table public.usage_events  enable row level security;

-- Families: your own; the owner also sees the names of families they created, nothing inside them.
create policy families_select on public.families for select to authenticated
  using (id = public.my_family_id() or (public.is_app_owner() and created_by = auth.uid()));
create policy families_update on public.families for update to authenticated
  using (id = public.my_family_id() and public.is_family_admin())
  with check (id = public.my_family_id());

-- Profiles: people in your own family.
create policy profiles_select on public.profiles for select to authenticated
  using (family_id = public.my_family_id());
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Invites: your family's, if you are its admin; plus invites you sent yourself.
create policy invites_select on public.invites for select to authenticated
  using ((family_id = public.my_family_id() and public.is_family_admin()) or invited_by = auth.uid());

-- Provider keys: metadata only (column grants above), and only for your family's admin.
create policy provider_keys_select on public.provider_keys for select to authenticated
  using (family_id = public.my_family_id() and public.is_family_admin());

-- Chats: yours; your family admin can read the row (title, model, dates), never the messages.
create policy chats_select on public.chats for select to authenticated
  using (owner_id = auth.uid() or public.i_admin(owner_id));
create policy chats_insert on public.chats for insert to authenticated
  with check (owner_id = auth.uid());
create policy chats_update on public.chats for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy chats_delete on public.chats for delete to authenticated
  using (owner_id = auth.uid());

-- Messages: yours only, and only into your own chats. No update or delete from the browser.
create policy messages_select on public.messages for select to authenticated
  using (owner_id = auth.uid());
create policy messages_insert on public.messages for insert to authenticated
  with check (
    owner_id = auth.uid()
    and role = 'user'
    and exists (select 1 from public.chats c where c.id = chat_id and c.owner_id = auth.uid())
  );

-- Memories: yours only.
create policy memories_select on public.memories for select to authenticated
  using (owner_id = auth.uid());
create policy memories_insert on public.memories for insert to authenticated
  with check (owner_id = auth.uid());
create policy memories_update on public.memories for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy memories_delete on public.memories for delete to authenticated
  using (owner_id = auth.uid());

-- Usage: yours, and your family admin's view of you. Written only by the server.
create policy usage_select on public.usage_events for select to authenticated
  using (owner_id = auth.uid() or public.i_admin(owner_id));
