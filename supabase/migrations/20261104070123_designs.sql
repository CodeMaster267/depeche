-- Personal designs ("My look"): each person can restyle and rearrange their own Depeche.
--
-- A design is a checked description of the look (colours, fonts, layout, extra buttons), never
-- code. A bigger model writes it from a brief, the server checks it, and the person keeps it or
-- undoes it. Builds cost money, so they are counted against an allowance each family admin sets,
-- and only the server (service role) writes any of these tables.
--
-- Who sees what:
--   * designs, design_current: only the person themselves.
--   * design_builds (the activity log): the person, whoever ran the build, and their family admin
--     (it holds the request and its cost, like usage; never chat contents).
--   * design_settings, design_allowances: the family can read its own settings; admins see every
--     member's allowance.

create table public.design_settings (
  family_id         uuid primary key references public.families (id) on delete cascade,
  -- The kill switch: off means no builds, and everyone in the family sees the standard look.
  enabled           boolean not null default true,
  builds_per_month  integer not null default 10 check (builds_per_month between 0 and 500),
  updated_by        uuid references public.profiles (id) on delete set null,
  updated_at        timestamptz not null default now()
);

create table public.design_allowances (
  person_id         uuid primary key references public.profiles (id) on delete cascade,
  builds_per_month  integer not null check (builds_per_month between 0 and 500),
  updated_by        uuid references public.profiles (id) on delete set null,
  updated_at        timestamptz not null default now()
);

create table public.design_builds (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families (id) on delete cascade,
  -- Whose Depeche the build is for.
  owner_id      uuid not null references public.profiles (id) on delete cascade,
  -- Who asked (the person, or their admin building on their behalf). Counted against this person.
  requested_by  uuid references public.profiles (id) on delete set null,
  brief         text not null check (char_length(brief) between 1 and 2000),
  status        text not null default 'building' check (status in ('building', 'built', 'failed', 'refused')),
  model         text,
  cost_usd      numeric(10, 6) not null default 0 check (cost_usd >= 0),
  -- Parts of the request the design couldn't do (shown to admins as a to-do list).
  unmet         text[] not null default '{}' check (cardinality(unmet) <= 8),
  note          text check (char_length(note) <= 500),
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index design_builds_family_idx on public.design_builds (family_id, created_at desc);
create index design_builds_requester_idx on public.design_builds (requested_by, created_at desc);

create table public.designs (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  build_id    uuid references public.design_builds (id) on delete set null,
  made_by     uuid references public.profiles (id) on delete set null,
  name        text not null check (char_length(name) between 1 and 60),
  spec        jsonb not null check (octet_length(spec::text) <= 20000),
  -- preview: waiting for Keep or Undo. offered: made by an admin, waiting for the person.
  status      text not null check (status in ('preview', 'offered', 'kept', 'undone')),
  created_at  timestamptz not null default now(),
  kept_at     timestamptz
);
create index designs_owner_idx on public.designs (owner_id, created_at desc);

-- The design each person is using now (none: the standard look).
create table public.design_current (
  owner_id    uuid primary key references public.profiles (id) on delete cascade,
  design_id   uuid references public.designs (id) on delete set null,
  updated_at  timestamptz not null default now()
);

-- Supabase grants everything on new tables by default; take it back. Signed-in people may only read.
revoke all on public.design_settings, public.design_allowances, public.design_builds, public.designs, public.design_current
  from public, anon, authenticated;
grant select on public.design_settings, public.design_allowances, public.design_builds, public.designs, public.design_current
  to authenticated;

alter table public.design_settings enable row level security;
alter table public.design_allowances enable row level security;
alter table public.design_builds enable row level security;
alter table public.designs enable row level security;
alter table public.design_current enable row level security;

create policy design_settings_select on public.design_settings for select to authenticated
  using (family_id = public.my_family_id());
create policy design_allowances_select on public.design_allowances for select to authenticated
  using (person_id = auth.uid() or (public.is_family_admin() and exists (
    select 1 from public.profiles p where p.id = person_id and p.family_id = public.my_family_id())));
create policy design_builds_select on public.design_builds for select to authenticated
  using (owner_id = auth.uid() or requested_by = auth.uid()
    or (family_id = public.my_family_id() and public.is_family_admin()));
create policy designs_select on public.designs for select to authenticated
  using (owner_id = auth.uid());
create policy design_current_select on public.design_current for select to authenticated
  using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Builds: counted against an allowance, failures not counted
-- ---------------------------------------------------------------------------

-- How many builds this person may run this month: their own allowance, else the family's.
create function public.design_allowance(p_person uuid) returns integer
  language sql stable security definer set search_path = ''
  as $$
    select coalesce(
      (select builds_per_month from public.design_allowances where person_id = p_person),
      (select s.builds_per_month from public.design_settings s join public.profiles p on p.family_id = s.family_id where p.id = p_person),
      10)
  $$;

-- Builds this person ran this calendar month (UTC) that count: finished ones, and ones still running
-- (a build that never finished stops counting after ten minutes). Failed and refused builds don't.
create function public.design_builds_used(p_person uuid) returns integer
  language sql stable security definer set search_path = ''
  as $$
    select count(*)::integer from public.design_builds
    where requested_by = p_person
      and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
      and (status = 'built' or (status = 'building' and created_at > now() - interval '10 minutes'))
  $$;

-- Starts a build if the family has designs on and the requester has builds left. Done in one
-- step with the requester's row locked, so two builds at once can't both take the last one.
create function public.start_design_build(p_requester uuid, p_owner uuid, p_brief text) returns uuid
  language plpgsql security definer set search_path = ''
  as $$
  declare
    fam uuid;
    allowed integer;
    used integer;
    build uuid;
  begin
    select family_id into fam from public.profiles where id = p_requester for update;
    if fam is null then
      raise exception 'Sign in again' using errcode = 'P0001';
    end if;
    if p_owner <> p_requester and not public.is_admin_of(p_requester, p_owner) then
      raise exception 'Only their family admin can design for someone else' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.design_settings where family_id = fam and not enabled) then
      raise exception 'Your family admin has turned off redesigns for now' using errcode = 'P0001';
    end if;
    allowed := public.design_allowance(p_requester);
    used := public.design_builds_used(p_requester);
    if used >= allowed then
      raise exception 'You''ve used all % of this month''s design builds. They reset on the 1st, or your family admin can give you more', allowed
        using errcode = 'P0001';
    end if;
    insert into public.design_builds (family_id, owner_id, requested_by, brief)
      values (fam, p_owner, p_requester, left(p_brief, 2000))
      returning id into build;
    return build;
  end
  $$;

-- Admin settings, checked and done in the database like the spending caps.
create function public.set_design_settings(p_actor uuid, p_enabled boolean, p_builds integer) returns void
  language plpgsql security definer set search_path = ''
  as $$
  declare
    fam uuid;
  begin
    select family_id into fam from public.profiles where id = p_actor and role = 'admin';
    if fam is null then
      raise exception 'Only a family admin can change this' using errcode = 'P0001';
    end if;
    if p_builds is null or p_builds < 0 or p_builds > 500 then
      raise exception 'Enter a number of builds from 0 to 500' using errcode = 'P0001';
    end if;
    insert into public.design_settings (family_id, enabled, builds_per_month, updated_by, updated_at)
      values (fam, coalesce(p_enabled, true), p_builds, p_actor, now())
      on conflict (family_id) do update
        set enabled = excluded.enabled, builds_per_month = excluded.builds_per_month,
            updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  end
  $$;

-- A member's own allowance; null goes back to the family's.
create function public.set_design_allowance(p_actor uuid, p_member uuid, p_builds integer) returns void
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if not public.is_admin_of(p_actor, p_member) then
      raise exception 'Only this family''s admin can change allowances' using errcode = 'P0001';
    end if;
    if p_builds is null then
      delete from public.design_allowances where person_id = p_member;
      return;
    end if;
    if p_builds < 0 or p_builds > 500 then
      raise exception 'Enter a number of builds from 0 to 500' using errcode = 'P0001';
    end if;
    insert into public.design_allowances (person_id, builds_per_month, updated_by, updated_at)
      values (p_member, p_builds, p_actor, now())
      on conflict (person_id) do update
        set builds_per_month = excluded.builds_per_month, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  end
  $$;

revoke all on function
  public.design_allowance(uuid), public.design_builds_used(uuid),
  public.start_design_build(uuid, uuid, text),
  public.set_design_settings(uuid, boolean, integer), public.set_design_allowance(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function
  public.design_allowance(uuid), public.design_builds_used(uuid),
  public.start_design_build(uuid, uuid, text),
  public.set_design_settings(uuid, boolean, integer), public.set_design_allowance(uuid, uuid, integer)
  to service_role;
