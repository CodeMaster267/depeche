-- Sign-in and families.
--
-- Everything here runs on the server with the service role, never from the browser:
-- setting up the app owner, creating families, creating and accepting invites, caps and
-- usernames. Each function takes the acting person's id explicitly; the server passes the id
-- of the signed-in person after checking their session. None of these functions is callable
-- by `anon` or `authenticated`.
--
-- Invite links carry a random token. Only its SHA-256 hash is stored, so a database leak
-- does not leak working invite links.

-- One admin per family, enforced by the database.
create unique index profiles_one_admin_per_family on public.profiles (family_id) where role = 'admin';

-- The admin types the person's name when inviting them, so accepting needs no extra step.
alter table public.invites
  add column display_name text not null default 'New member'
  check (char_length(display_name) between 1 and 60);

-- Signing in by username is case-insensitive; usernames are stored lower-case.
alter table public.profiles add constraint profiles_username_lower check (username = lower(username));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function public.app_owner_exists() returns boolean
  language sql stable security definer set search_path = ''
  as $$ select exists (select 1 from public.profiles where is_app_owner) $$;

-- True when `actor` is the admin of the family `person` belongs to (including themselves).
create function public.is_admin_of(actor uuid, person uuid) returns boolean
  language sql stable security definer set search_path = ''
  as $$
    select exists (
      select 1
      from public.profiles me
      join public.profiles them on them.family_id = me.family_id
      where me.id = actor and me.role = 'admin' and them.id = person
    )
  $$;

create function public.email_of(person uuid) returns text
  language sql stable security definer set search_path = ''
  as $$ select lower(email) from auth.users where id = person $$;

create function public.email_for_username(p_username text) returns text
  language sql stable security definer set search_path = ''
  as $$
    select lower(u.email)
    from public.profiles p join auth.users u on u.id = p.id
    where p.username = lower(trim(p_username))
  $$;

-- ---------------------------------------------------------------------------
-- The app owner. Runs once, the first time Hasan signs in.
-- ---------------------------------------------------------------------------

create function public.bootstrap_owner(p_user uuid, p_display_name text, p_family_name text)
  returns uuid
  language plpgsql security definer set search_path = ''
  as $$
  declare
    fam uuid;
  begin
    -- Two simultaneous attempts cannot both succeed.
    perform pg_advisory_xact_lock(hashtext('depeche.bootstrap_owner'));
    if public.app_owner_exists() then
      raise exception 'Depeche already has an owner' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.profiles where id = p_user) then
      raise exception 'This person already has a profile' using errcode = 'P0001';
    end if;
    insert into public.families (name, created_by) values (trim(p_family_name), p_user) returning id into fam;
    insert into public.profiles (id, family_id, role, is_app_owner, display_name)
      values (p_user, fam, 'admin', true, trim(p_display_name));
    return fam;
  end
  $$;

-- The owner creates another family. Its first admin is then invited with create_invite.
create function public.create_family(p_actor uuid, p_name text) returns uuid
  language plpgsql security definer set search_path = ''
  as $$
  declare
    fam uuid;
  begin
    if not exists (select 1 from public.profiles where id = p_actor and is_app_owner) then
      raise exception 'Only the owner can create families' using errcode = 'P0001';
    end if;
    insert into public.families (name, created_by) values (trim(p_name), p_actor) returning id into fam;
    return fam;
  end
  $$;

-- ---------------------------------------------------------------------------
-- Invites
-- ---------------------------------------------------------------------------

-- A family admin invites members to their own family. The owner invites the first admin of a
-- family they created, and only while it has no admin. Inviting the same email again replaces
-- the earlier unused invite.
create function public.create_invite(
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

    if exists (
      select 1 from public.profiles p join auth.users u on u.id = p.id where lower(u.email) = addr
    ) then
      raise exception 'Someone with that email already has a Depeche account' using errcode = 'P0001';
    end if;

    delete from public.invites where family_id = p_family and email = addr and accepted_at is null;
    insert into public.invites (family_id, email, display_name, role, invited_by, token_hash, expires_at)
      values (p_family, addr, trim(p_display_name), p_role, p_actor, p_token_hash, p_expires_at)
      returning id into inv;
    return inv;
  end
  $$;

-- What the invite page shows before someone accepts. Never returns the token.
create function public.invite_preview(p_token_hash text)
  returns table (family_name text, email text, display_name text, role public.member_role, state text)
  language sql stable security definer set search_path = ''
  as $$
    select f.name, i.email, i.display_name, i.role,
           case when i.accepted_at is not null then 'used'
                when i.expires_at <= now() then 'expired'
                else 'valid' end
    from public.invites i join public.families f on f.id = i.family_id
    where i.token_hash = p_token_hash
  $$;

-- Turns an invite into a profile. The signed-in person's email must match the invite's.
create function public.accept_invite_row(p_invite public.invites, p_user uuid) returns uuid
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if p_invite.accepted_at is not null then
      raise exception 'This invite has already been used' using errcode = 'P0001';
    end if;
    if p_invite.expires_at <= now() then
      raise exception 'This invite has expired' using errcode = 'P0001';
    end if;
    if public.email_of(p_user) is distinct from p_invite.email then
      raise exception 'This invite is for a different email address' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.profiles where id = p_user) then
      raise exception 'This person already has a profile' using errcode = 'P0001';
    end if;
    insert into public.profiles (id, family_id, role, display_name)
      values (p_user, p_invite.family_id, p_invite.role, p_invite.display_name);
    update public.invites set accepted_at = now() where id = p_invite.id;
    return p_invite.family_id;
  end
  $$;

-- Accept the invite behind a specific link (used when someone sets a password on the invite page).
create function public.accept_invite(p_token_hash text, p_user uuid) returns uuid
  language plpgsql security definer set search_path = ''
  as $$
  declare
    inv public.invites;
  begin
    select * into inv from public.invites where token_hash = p_token_hash for update;
    if not found then
      raise exception 'This invite does not exist' using errcode = 'P0001';
    end if;
    return public.accept_invite_row(inv, p_user);
  end
  $$;

-- Accept the newest open invite for the signed-in person's email (used after Google or an
-- email link, where proving the email is what matters). Returns null when there is none.
create function public.accept_pending_invite(p_user uuid) returns uuid
  language plpgsql security definer set search_path = ''
  as $$
  declare
    inv public.invites;
  begin
    select * into inv from public.invites
      where email = public.email_of(p_user) and accepted_at is null and expires_at > now()
      order by created_at desc limit 1
      for update;
    if not found then
      return null;
    end if;
    return public.accept_invite_row(inv, p_user);
  end
  $$;

create function public.revoke_invite(p_actor uuid, p_invite uuid) returns void
  language plpgsql security definer set search_path = ''
  as $$
  begin
    delete from public.invites i
      where i.id = p_invite and i.accepted_at is null
        and (i.invited_by = p_actor
             or exists (select 1 from public.profiles me
                        where me.id = p_actor and me.role = 'admin' and me.family_id = i.family_id));
    if not found then
      raise exception 'You cannot cancel this invite' using errcode = 'P0001';
    end if;
  end
  $$;

-- ---------------------------------------------------------------------------
-- Caps and usernames
-- ---------------------------------------------------------------------------

create function public.set_member_cap(p_actor uuid, p_member uuid, p_cap numeric) returns void
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if not public.is_admin_of(p_actor, p_member) then
      raise exception 'Only this family''s admin can change caps' using errcode = 'P0001';
    end if;
    update public.profiles set monthly_cap_usd = p_cap where id = p_member;
  end
  $$;

-- Sets or clears (null) a person's own username.
create function public.set_username(p_user uuid, p_username text) returns void
  language plpgsql security definer set search_path = ''
  as $$
  begin
    update public.profiles set username = nullif(lower(trim(p_username)), '') where id = p_user;
    if not found then
      raise exception 'No profile' using errcode = 'P0001';
    end if;
  end
  $$;

-- ---------------------------------------------------------------------------
-- Only the server may call any of this.
-- ---------------------------------------------------------------------------

revoke all on function
  public.app_owner_exists(), public.is_admin_of(uuid, uuid), public.email_of(uuid),
  public.email_for_username(text), public.bootstrap_owner(uuid, text, text),
  public.create_family(uuid, text),
  public.create_invite(uuid, uuid, text, text, public.member_role, text, timestamptz),
  public.invite_preview(text), public.accept_invite_row(public.invites, uuid),
  public.accept_invite(text, uuid), public.accept_pending_invite(uuid),
  public.revoke_invite(uuid, uuid), public.set_member_cap(uuid, uuid, numeric),
  public.set_username(uuid, text)
  from public, anon, authenticated;

grant execute on function
  public.app_owner_exists(), public.is_admin_of(uuid, uuid), public.email_of(uuid),
  public.email_for_username(text), public.bootstrap_owner(uuid, text, text),
  public.create_family(uuid, text),
  public.create_invite(uuid, uuid, text, text, public.member_role, text, timestamptz),
  public.invite_preview(text), public.accept_invite_row(public.invites, uuid),
  public.accept_invite(text, uuid), public.accept_pending_invite(uuid),
  public.revoke_invite(uuid, uuid), public.set_member_cap(uuid, uuid, numeric),
  public.set_username(uuid, text)
  to service_role;
