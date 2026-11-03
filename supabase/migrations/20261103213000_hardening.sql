-- Hardening: hard spending caps, rate limits, an admin log, temporary passwords, a backup admin,
-- signing people out, 7-day invites and chat titles that stay private unless the member shares them.
--
-- As before, everything that costs money or changes trust runs here, in functions only the server
-- (service role) can call. Each takes the acting person's id; the server passes the id of the
-- signed-in person after checking their session. Every check of "may this person do that" lives in
-- the database, so the server cannot forget one and the tests in tests/db/ can prove each of them.

-- ---------------------------------------------------------------------------
-- Spending: reserve the worst case before a reply, settle the real cost afterwards
-- ---------------------------------------------------------------------------
--
-- Before calling a provider, the server reserves the most the reply could cost (a hold). Holds count
-- against the monthly limit exactly like spending, so several replies at once cannot together go
-- past it. A person's holds are taken one at a time (an advisory lock), so two simultaneous requests
-- cannot both see the same remaining budget. When the reply ends, the hold is swapped for the real
-- usage. A hold left behind by a crash stops counting after ten minutes.

create table public.spend_holds (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  amount_usd  numeric(12, 6) not null check (amount_usd >= 0),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '10 minutes'
);
create index spend_holds_owner_idx on public.spend_holds (owner_id, expires_at);

/** At most this many replies can be written for one person at the same time. */
create function public.max_parallel_replies() returns integer language sql immutable as $$ select 3 $$;

-- Spending this month plus every hold still open.
create function public.month_committed(p_person uuid) returns numeric
  language sql stable security definer set search_path = ''
  as $$
    select public.month_spend(p_person)
         + coalesce((select sum(amount_usd) from public.spend_holds
                     where owner_id = p_person and expires_at > now()), 0)
  $$;

-- Reserve up to `p_want` dollars for one reply. If less than that is left this month, reserve what
-- is left, as long as it is at least `p_need` (the cheapest useful reply). Returns the hold and how
-- much it holds; the server then limits the reply's length to fit.
create function public.reserve_spend(p_person uuid, p_want numeric, p_need numeric)
  returns table (hold_id uuid, amount_usd numeric)
  language plpgsql security definer set search_path = ''
  as $$
  declare
    cap numeric;
    left_usd numeric;
    open_holds integer;
    grant_usd numeric;
    hold uuid;
  begin
    if p_want is null or p_need is null or p_want < 0 or p_need < 0 then
      raise exception 'Bad amount' using errcode = 'P0001';
    end if;
    perform pg_advisory_xact_lock(hashtext('depeche.spend'), hashtext(p_person::text));
    select monthly_cap_usd into cap from public.profiles where id = p_person;
    if cap is null then
      raise exception 'No profile' using errcode = 'P0001';
    end if;
    select count(*) into open_holds from public.spend_holds where owner_id = p_person and expires_at > now();
    if open_holds >= public.max_parallel_replies() then
      raise exception 'Too many replies at once. Wait for one to finish' using errcode = 'P0001';
    end if;
    left_usd := cap - public.month_committed(p_person);
    if left_usd <= 0 or left_usd < p_need then
      raise exception 'You''ve reached your $% limit for this month. Your family admin can raise it',
        to_char(cap, 'FM999999990.00') using errcode = 'P0001';
    end if;
    grant_usd := least(p_want, left_usd);
    insert into public.spend_holds (owner_id, amount_usd) values (p_person, grant_usd) returning id into hold;
    return query select hold, grant_usd;
  end
  $$;

-- Swap a hold for what the reply really cost. Recording the real cost even when it is more than the
-- hold (an estimate can be wrong) means the next request sees it.
create function public.settle_spend(
  p_hold uuid, p_message uuid, p_provider text, p_model text,
  p_input integer, p_output integer, p_cost numeric
) returns void
  language plpgsql security definer set search_path = ''
  as $$
  declare
    person uuid;
  begin
    delete from public.spend_holds where id = p_hold returning owner_id into person;
    if person is null then
      raise exception 'No such hold' using errcode = 'P0001';
    end if;
    if coalesce(p_input, 0) > 0 or coalesce(p_output, 0) > 0 or coalesce(p_cost, 0) > 0 then
      insert into public.usage_events (owner_id, message_id, provider, model, input_tokens, output_tokens, cost_usd)
        values (person, p_message, p_provider, p_model, greatest(p_input, 0), greatest(p_output, 0), greatest(p_cost, 0));
    end if;
  end
  $$;

-- ---------------------------------------------------------------------------
-- Rate limits
-- ---------------------------------------------------------------------------
--
-- Counts attempts per key (for example "sign-in:ip:1.2.3.4") in fixed windows. Returns false once a
-- key has used up its attempts across the current window and the one before.

create table public.rate_limits (
  key           text not null check (char_length(key) between 1 and 300),
  window_start  timestamptz not null,
  hits          integer not null default 0,
  primary key (key, window_start)
);

-- How many attempts a key has used, without counting a new one. Attempts in the current window and
-- the one before both count, so the count never drops to zero just because a window ended.
create function public.rate_limit_used(p_key text, p_window_seconds integer) returns integer
  language sql stable security definer set search_path = ''
  as $$
    select coalesce(sum(hits), 0)::integer from public.rate_limits
    where key = p_key
      and window_start >= to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds - p_window_seconds)
  $$;

create function public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer) returns boolean
  language plpgsql security definer set search_path = ''
  as $$
  declare
    win timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
    n integer;
  begin
    insert into public.rate_limits as r (key, window_start, hits) values (p_key, win, 1)
      on conflict (key, window_start) do update set hits = r.hits + 1;
    -- Old windows are of no use; tidy up now and then.
    if random() < 0.02 then
      delete from public.rate_limits where window_start < now() - interval '2 days';
    end if;
    n := public.rate_limit_used(p_key, p_window_seconds);
    return n <= p_limit;
  end
  $$;

-- ---------------------------------------------------------------------------
-- Admin log
-- ---------------------------------------------------------------------------
--
-- Every admin action is written by the same database function that performs it, so it cannot be
-- skipped. A family's admins see their family's log; everyone sees the entries about themselves.

create table public.admin_log (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families (id) on delete cascade,
  actor_id    uuid references public.profiles (id) on delete set null,
  subject_id  uuid references public.profiles (id) on delete set null,
  action      text not null check (action in (
                'invite_created', 'invite_cancelled', 'cap_changed', 'password_reset',
                'signed_out', 'admin_added', 'admin_removed', 'key_saved', 'key_removed')),
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index admin_log_family_idx on public.admin_log (family_id, created_at desc);
create index admin_log_subject_idx on public.admin_log (subject_id, created_at desc);

create function public.log_admin(p_family uuid, p_actor uuid, p_subject uuid, p_action text, p_detail jsonb default '{}'::jsonb)
  returns void
  language sql security definer set search_path = ''
  as $$
    insert into public.admin_log (family_id, actor_id, subject_id, action, detail)
      values (p_family, p_actor, p_subject, p_action, coalesce(p_detail, '{}'::jsonb))
  $$;

-- ---------------------------------------------------------------------------
-- Backup admin: up to two admins per family, never none
-- ---------------------------------------------------------------------------

drop index public.profiles_one_admin_per_family;

create function public.check_admin_count() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if (select count(*) from public.profiles where family_id = new.family_id and role = 'admin') > 2 then
      raise exception 'A family can have at most two admins' using errcode = 'P0001';
    end if;
    return null;
  end
  $$;
create constraint trigger profiles_at_most_two_admins
  after insert or update of role, family_id on public.profiles
  deferrable initially immediate
  for each row when (new.role = 'admin') execute function public.check_admin_count();

-- An admin makes a member the family's second admin, or removes an admin (themselves or the other
-- one). A family always keeps at least one admin, and the app owner stays admin of their own family.
create function public.set_admin(p_actor uuid, p_member uuid, p_admin boolean) returns void
  language plpgsql security definer set search_path = ''
  as $$
  declare
    them public.profiles;
    admins integer;
  begin
    select * into them from public.profiles where id = p_member for update;
    if them.id is null or not public.is_admin_of(p_actor, p_member) then
      raise exception 'Only this family''s admin can change admins' using errcode = 'P0001';
    end if;
    perform pg_advisory_xact_lock(hashtext('depeche.admins'), hashtext(them.family_id::text));
    select count(*) into admins from public.profiles where family_id = them.family_id and role = 'admin';
    if p_admin then
      if them.role = 'admin' then return; end if;
      if admins >= 2 then
        raise exception 'This family already has a backup admin' using errcode = 'P0001';
      end if;
      update public.profiles set role = 'admin' where id = p_member;
      perform public.log_admin(them.family_id, p_actor, p_member, 'admin_added');
    else
      if them.role <> 'admin' then return; end if;
      if admins <= 1 then
        raise exception 'A family needs at least one admin' using errcode = 'P0001';
      end if;
      if them.is_app_owner then
        raise exception 'The owner stays an admin of their own family' using errcode = 'P0001';
      end if;
      update public.profiles set role = 'member' where id = p_member;
      perform public.log_admin(them.family_id, p_actor, p_member, 'admin_removed');
    end if;
  end
  $$;

-- ---------------------------------------------------------------------------
-- Signing out, and temporary passwords
-- ---------------------------------------------------------------------------

-- Ends every session a person has, on every device. Anyone can do this for themselves; a family
-- admin can do it for anyone in their family.
create function public.sign_out_everywhere(p_actor uuid, p_person uuid) returns void
  language plpgsql security definer set search_path = ''
  as $$
  declare
    fam uuid;
  begin
    select family_id into fam from public.profiles where id = p_person;
    if fam is null or (p_actor is distinct from p_person and not public.is_admin_of(p_actor, p_person)) then
      raise exception 'Only this family''s admin can sign someone out' using errcode = 'P0001';
    end if;
    delete from auth.sessions where user_id = p_person;
    perform public.log_admin(fam, p_actor, p_person, 'signed_out');
  end
  $$;

-- A one-time temporary password. The admin's check runs here before the server sets the password;
-- the person is signed out everywhere and must choose their own password when they next sign in.
-- An unused temporary password stops working after a day.
alter table public.profiles
  add column must_change_password boolean not null default false,
  add column temp_password_until timestamptz;

create function public.start_password_reset(p_actor uuid, p_member uuid) returns void
  language plpgsql security definer set search_path = ''
  as $$
  declare
    fam uuid;
  begin
    if p_actor = p_member or not public.is_admin_of(p_actor, p_member) then
      raise exception 'Only this family''s admin can reset passwords' using errcode = 'P0001';
    end if;
    update public.profiles
      set must_change_password = true, temp_password_until = now() + interval '1 day'
      where id = p_member returning family_id into fam;
    delete from auth.sessions where user_id = p_member;
    perform public.log_admin(fam, p_actor, p_member, 'password_reset');
  end
  $$;

-- The person chose their own password: the temporary one is gone.
create function public.password_changed(p_user uuid) returns void
  language sql security definer set search_path = ''
  as $$ update public.profiles set must_change_password = false, temp_password_until = null where id = p_user $$;

-- ---------------------------------------------------------------------------
-- Invites last 7 days, and creating or cancelling one is logged
-- ---------------------------------------------------------------------------

create or replace function public.create_invite(
  p_actor uuid, p_family uuid, p_email text, p_display_name text,
  p_role public.member_role, p_token_hash text, p_expires_at timestamptz
) returns uuid
  language plpgsql security definer set search_path = ''
  as $$
  declare
    addr text := lower(trim(p_email));
    inv uuid;
  begin
    if p_role = 'member' then
      if not exists (
        select 1 from public.profiles where id = p_actor and family_id = p_family and role = 'admin'
      ) then
        raise exception 'Only this family''s admin can invite members' using errcode = 'P0001';
      end if;
    else
      if not exists (
        select 1 from public.profiles me join public.families f on f.created_by = me.id
        where me.id = p_actor and me.is_app_owner and f.id = p_family
      ) then
        raise exception 'Only the owner can invite a family''s first admin' using errcode = 'P0001';
      end if;
      if exists (select 1 from public.profiles where family_id = p_family and role = 'admin') then
        raise exception 'This family already has an admin' using errcode = 'P0001';
      end if;
    end if;

    if p_expires_at is null or p_expires_at > now() + interval '7 days 1 minute' then
      raise exception 'Invites last at most 7 days' using errcode = 'P0001';
    end if;

    if exists (
      select 1 from public.profiles p join auth.users u on u.id = p.id where lower(u.email) = addr
    ) then
      raise exception 'Someone with that email already has a Depeche account' using errcode = 'P0001';
    end if;

    delete from public.invites where family_id = p_family and email = addr and accepted_at is null;
    insert into public.invites (family_id, email, display_name, role, invited_by, token_hash, expires_at)
      values (p_family, addr, trim(p_display_name), p_role, p_actor, p_token_hash, p_expires_at)
      returning id into inv;
    -- An owner's invite to another family's first admin is not that family's admin business yet,
    -- but it is still recorded against that family so its admin can see how they were invited.
    perform public.log_admin(p_family, p_actor, null, 'invite_created',
      jsonb_build_object('email', addr, 'name', trim(p_display_name), 'role', p_role));
    return inv;
  end
  $$;

create or replace function public.revoke_invite(p_actor uuid, p_invite uuid) returns void
  language plpgsql security definer set search_path = ''
  as $$
  declare
    inv public.invites;
  begin
    delete from public.invites i
      where i.id = p_invite and i.accepted_at is null
        and (i.invited_by = p_actor
             or exists (select 1 from public.profiles me
                        where me.id = p_actor and me.role = 'admin' and me.family_id = i.family_id))
      returning * into inv;
    if inv.id is null then
      raise exception 'You cannot cancel this invite' using errcode = 'P0001';
    end if;
    perform public.log_admin(inv.family_id, p_actor, null, 'invite_cancelled',
      jsonb_build_object('email', inv.email, 'name', inv.display_name));
  end
  $$;

-- ---------------------------------------------------------------------------
-- Caps and keys, now logged
-- ---------------------------------------------------------------------------

create or replace function public.set_member_cap(p_actor uuid, p_member uuid, p_cap numeric) returns void
  language plpgsql security definer set search_path = ''
  as $$
  declare
    before numeric;
    fam uuid;
  begin
    if not public.is_admin_of(p_actor, p_member) then
      raise exception 'Only this family''s admin can change caps' using errcode = 'P0001';
    end if;
    if p_cap is null or p_cap < 0 or p_cap > 100000 then
      raise exception 'Enter an amount in dollars' using errcode = 'P0001';
    end if;
    select monthly_cap_usd, family_id into before, fam from public.profiles where id = p_member for update;
    update public.profiles set monthly_cap_usd = p_cap where id = p_member;
    if before is distinct from p_cap then
      perform public.log_admin(fam, p_actor, p_member, 'cap_changed', jsonb_build_object('from', before, 'to', p_cap));
    end if;
  end
  $$;

create or replace function public.save_provider_key(p_actor uuid, p_provider text, p_ciphertext bytea, p_last4 text)
  returns void
  language plpgsql security definer set search_path = ''
  as $$
  declare
    fam uuid;
  begin
    select family_id into fam from public.profiles where id = p_actor and role = 'admin';
    if fam is null then
      raise exception 'Only a family admin can add keys' using errcode = 'P0001';
    end if;
    insert into public.provider_keys (family_id, provider, ciphertext, last4, created_by)
      values (fam, p_provider, p_ciphertext, p_last4, p_actor)
      on conflict (family_id, provider) do update
        set ciphertext = excluded.ciphertext, last4 = excluded.last4,
            created_by = excluded.created_by, updated_at = now();
    perform public.log_admin(fam, p_actor, null, 'key_saved', jsonb_build_object('provider', p_provider, 'last4', p_last4));
  end
  $$;

create or replace function public.remove_provider_key(p_actor uuid, p_provider text) returns void
  language plpgsql security definer set search_path = ''
  as $$
  declare
    fam uuid;
  begin
    select family_id into fam from public.profiles where id = p_actor and role = 'admin';
    if fam is null then
      raise exception 'Only a family admin can remove keys' using errcode = 'P0001';
    end if;
    delete from public.provider_keys where provider = p_provider and family_id = fam;
    if found then
      perform public.log_admin(fam, p_actor, null, 'key_removed', jsonb_build_object('provider', p_provider));
    end if;
  end
  $$;

-- ---------------------------------------------------------------------------
-- Chat titles: private unless the member chooses to share them with their family admin
-- ---------------------------------------------------------------------------

alter table public.profiles add column share_titles boolean not null default false;
grant update (share_titles) on public.profiles to authenticated;

create function public.shares_titles(person uuid) returns boolean
  language sql stable security definer set search_path = ''
  as $$ select coalesce((select share_titles from public.profiles where id = person), false) $$;
revoke all on function public.shares_titles(uuid) from public, anon;
grant execute on function public.shares_titles(uuid) to authenticated;

drop policy chats_select on public.chats;
create policy chats_select on public.chats for select to authenticated
  using (owner_id = auth.uid() or (public.i_admin(owner_id) and public.shares_titles(owner_id)));

-- ---------------------------------------------------------------------------
-- System checks: what scheduled jobs (backups, restore tests, keep-alive) report, for the Health
-- screen and alerts. Written by GitHub Actions through the database connection, read by the server.
-- ---------------------------------------------------------------------------

create table public.system_checks (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('backup', 'restore_test', 'keep_alive', 'health_check')),
  ok          boolean not null,
  detail      text check (char_length(detail) <= 2000),
  created_at  timestamptz not null default now()
);
create index system_checks_kind_idx on public.system_checks (kind, created_at desc);
revoke all on public.system_checks from anon, authenticated;
alter table public.system_checks enable row level security;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on public.spend_holds, public.rate_limits, public.admin_log from anon, authenticated;
alter table public.spend_holds enable row level security;
alter table public.rate_limits enable row level security;
alter table public.admin_log   enable row level security;

grant select on public.admin_log to authenticated;
create policy admin_log_select on public.admin_log for select to authenticated
  using ((family_id = public.my_family_id() and public.is_family_admin()) or subject_id = auth.uid());

revoke all on function
  public.month_committed(uuid), public.reserve_spend(uuid, numeric, numeric),
  public.settle_spend(uuid, uuid, text, text, integer, integer, numeric),
  public.rate_limit_hit(text, integer, integer), public.rate_limit_used(text, integer),
  public.log_admin(uuid, uuid, uuid, text, jsonb), public.check_admin_count(),
  public.set_admin(uuid, uuid, boolean), public.sign_out_everywhere(uuid, uuid),
  public.start_password_reset(uuid, uuid), public.password_changed(uuid),
  public.create_invite(uuid, uuid, text, text, public.member_role, text, timestamptz),
  public.revoke_invite(uuid, uuid), public.set_member_cap(uuid, uuid, numeric),
  public.save_provider_key(uuid, text, bytea, text), public.remove_provider_key(uuid, text)
  from public, anon, authenticated;
grant execute on function
  public.month_committed(uuid), public.reserve_spend(uuid, numeric, numeric),
  public.settle_spend(uuid, uuid, text, text, integer, integer, numeric),
  public.rate_limit_hit(text, integer, integer), public.rate_limit_used(text, integer),
  public.log_admin(uuid, uuid, uuid, text, jsonb),
  public.set_admin(uuid, uuid, boolean), public.sign_out_everywhere(uuid, uuid),
  public.start_password_reset(uuid, uuid), public.password_changed(uuid),
  public.create_invite(uuid, uuid, text, text, public.member_role, text, timestamptz),
  public.revoke_invite(uuid, uuid), public.set_member_cap(uuid, uuid, numeric),
  public.save_provider_key(uuid, text, bytea, text), public.remove_provider_key(uuid, text)
  to service_role;
