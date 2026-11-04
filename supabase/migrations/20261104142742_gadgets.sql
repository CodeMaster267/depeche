-- Gadgets: small apps a model builds in a chat (a calculator, a quiz, chess against a model),
-- saved by a person to use again, changed by asking, and shared as copies within the family.
-- Plus "No limit": a family admin can let a person spend without a monthly limit.
--
-- A gadget's page is model output. It is only ever run sealed off in the browser (lib/widgets/
-- frame.ts), never in the app's origin. Rows here are written only by the server (service role);
-- people can read their own gadgets, and shares meant for them.

-- ---------------------------------------------------------------------------
-- No limit
-- ---------------------------------------------------------------------------

alter table public.profiles add column no_spend_limit boolean not null default false;
-- People can't change this themselves: profiles only grants updates on a few named columns.

-- As before, with one change: someone with no limit gets the whole hold they ask for.
create or replace function public.reserve_spend(p_person uuid, p_want numeric, p_need numeric)
  returns table (hold_id uuid, amount_usd numeric)
  language plpgsql security definer set search_path = ''
  as $$
  declare
    cap numeric;
    unlimited boolean;
    left_usd numeric;
    open_holds integer;
    grant_usd numeric;
    hold uuid;
  begin
    if p_want is null or p_need is null or p_want < 0 or p_need < 0 then
      raise exception 'Bad amount' using errcode = 'P0001';
    end if;
    perform pg_advisory_xact_lock(hashtext('depeche.spend'), hashtext(p_person::text));
    select monthly_cap_usd, no_spend_limit into cap, unlimited from public.profiles where id = p_person;
    if cap is null then
      raise exception 'No profile' using errcode = 'P0001';
    end if;
    select count(*) into open_holds from public.spend_holds where owner_id = p_person and expires_at > now();
    if open_holds >= public.max_parallel_replies() then
      raise exception 'Too many replies at once. Wait for one to finish' using errcode = 'P0001';
    end if;
    if unlimited then
      grant_usd := p_want;
    else
      left_usd := cap - public.month_committed(p_person);
      if left_usd <= 0 or left_usd < p_need then
        raise exception 'You''ve reached your $% limit for this month. Your family admin can raise it',
          to_char(cap, 'FM999999990.00') using errcode = 'P0001';
      end if;
      grant_usd := least(p_want, left_usd);
    end if;
    insert into public.spend_holds (owner_id, amount_usd) values (p_person, grant_usd) returning id into hold;
    return query select hold, grant_usd;
  end
  $$;

alter table public.admin_log drop constraint admin_log_action_check;
alter table public.admin_log add constraint admin_log_action_check check (action in (
  'invite_created', 'invite_cancelled', 'cap_changed', 'password_reset',
  'signed_out', 'admin_added', 'admin_removed', 'key_saved', 'key_removed',
  'limit_removed', 'limit_restored'));

create function public.set_member_no_limit(p_actor uuid, p_member uuid, p_on boolean) returns void
  language plpgsql security definer set search_path = ''
  as $$
  declare
    before boolean;
    fam uuid;
  begin
    if not public.is_admin_of(p_actor, p_member) then
      raise exception 'Only this family''s admin can change limits' using errcode = 'P0001';
    end if;
    if p_on is null then
      raise exception 'Choose limit or no limit' using errcode = 'P0001';
    end if;
    select no_spend_limit, family_id into before, fam from public.profiles where id = p_member for update;
    update public.profiles set no_spend_limit = p_on where id = p_member;
    if before is distinct from p_on then
      perform public.log_admin(fam, p_actor, p_member, case when p_on then 'limit_removed' else 'limit_restored' end, '{}'::jsonb);
    end if;
  end
  $$;

-- ---------------------------------------------------------------------------
-- Gadgets
-- ---------------------------------------------------------------------------

create table public.gadgets (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 60),
  html        text not null check (octet_length(html) <= 200000),
  -- The model the gadget asks when it talks to an AI (null: the person's usual model).
  model       text check (model is null or char_length(model) <= 80),
  -- Who shared it, when it's a copy of someone else's gadget.
  shared_by   uuid references public.profiles (id) on delete set null,
  chat_id     uuid references public.chats (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index gadgets_owner_idx on public.gadgets (owner_id, updated_at desc);

-- Every version, so a change can be undone. The newest is the gadget's own html.
create table public.gadget_versions (
  id          uuid primary key default gen_random_uuid(),
  gadget_id   uuid not null references public.gadgets (id) on delete cascade,
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  html        text not null check (octet_length(html) <= 200000),
  note        text not null default '' check (char_length(note) <= 300),
  created_at  timestamptz not null default now()
);
create index gadget_versions_idx on public.gadget_versions (gadget_id, created_at desc);

-- What a gadget remembers between uses (a game in progress, high scores). Small, and the owner's.
create table public.gadget_saves (
  gadget_id   uuid primary key references public.gadgets (id) on delete cascade,
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  data        text not null check (octet_length(data) <= 100000),
  updated_at  timestamptz not null default now()
);

-- A copy offered to one person (to_id) or to the whole family (to_id null, the family shelf).
-- It carries only the gadget's page and title: never saves, chats or settings.
create table public.gadget_shares (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families (id) on delete cascade,
  from_id     uuid not null references public.profiles (id) on delete cascade,
  to_id       uuid references public.profiles (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 60),
  html        text not null check (octet_length(html) <= 200000),
  taken       boolean not null default false,
  created_at  timestamptz not null default now()
);
create index gadget_shares_to_idx on public.gadget_shares (to_id, created_at desc);
create index gadget_shares_family_idx on public.gadget_shares (family_id, created_at desc) where to_id is null;

revoke all on public.gadgets, public.gadget_versions, public.gadget_saves, public.gadget_shares from public, anon, authenticated;
grant select on public.gadgets, public.gadget_versions, public.gadget_saves, public.gadget_shares to authenticated;
alter table public.gadgets enable row level security;
alter table public.gadget_versions enable row level security;
alter table public.gadget_saves enable row level security;
alter table public.gadget_shares enable row level security;

create policy gadgets_own on public.gadgets for select to authenticated using (owner_id = (select auth.uid()));
create policy gadget_versions_own on public.gadget_versions for select to authenticated using (owner_id = (select auth.uid()));
create policy gadget_saves_own on public.gadget_saves for select to authenticated using (owner_id = (select auth.uid()));
create policy gadget_shares_seen on public.gadget_shares for select to authenticated using (
  from_id = (select auth.uid())
  or to_id = (select auth.uid())
  or (to_id is null and family_id = (select public.my_family_id()))
);

revoke all on function public.set_member_no_limit(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_member_no_limit(uuid, uuid, boolean) to service_role;
