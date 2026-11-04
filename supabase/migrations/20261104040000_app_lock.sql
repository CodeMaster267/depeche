-- App lock: an optional PIN, plus Face ID / Touch ID (WebAuthn passkeys), that each person can put
-- on Depeche. It locks after a chosen time without use.
--
-- The PIN hash is never readable by anyone signed in, not even its owner: a 4-digit PIN is easy to
-- guess offline, so only the server (service role) reads it, and wrong guesses are counted here.
-- Passkeys hold only public keys; people can list their own devices but only the server adds,
-- changes or removes them.

create table public.app_locks (
  owner_id uuid primary key references public.profiles (id) on delete cascade,
  pin_hash text not null,
  pin_length smallint not null check (pin_length between 4 and 8),
  -- 0 means "as soon as you leave Depeche".
  timeout_seconds integer not null default 300 check (timeout_seconds between 0 and 86400),
  failed_tries integer not null default 0,
  wait_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.app_locks enable row level security;
revoke all on public.app_locks from public, anon, authenticated;
-- No policies on purpose: nobody signed in can see or change this table.

create table public.lock_passkeys (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  credential_id text not null unique check (length(credential_id) between 16 and 1400),
  public_key bytea not null,
  algorithm integer not null check (algorithm in (-7, -257)),
  sign_count bigint not null default 0,
  label text not null check (length(label) between 1 and 60),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index lock_passkeys_owner on public.lock_passkeys (owner_id);
alter table public.lock_passkeys enable row level security;
revoke all on public.lock_passkeys from public, anon, authenticated;
grant select (id, owner_id, label, created_at, last_used_at) on public.lock_passkeys to authenticated;
create policy "own passkeys" on public.lock_passkeys for select to authenticated using (owner_id = auth.uid());

-- Records a PIN attempt in one step, so two quick guesses can't both slip past the count.
-- Right: the count resets. Wrong: one more try is counted, and from the fifth wrong try in a row
-- the person waits 30 seconds, doubling each time (at most 15 minutes). Returns the new count and
-- how long to wait.
create function public.lock_pin_attempt(p_user uuid, p_ok boolean)
  returns table (failed_tries integer, wait_until timestamptz)
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if p_ok then
      return query
        update public.app_locks l set failed_tries = 0, wait_until = null
          where l.owner_id = p_user
          returning l.failed_tries, l.wait_until;
    else
      return query
        update public.app_locks l
          set failed_tries = l.failed_tries + 1,
              wait_until = case when l.failed_tries + 1 >= 5
                then now() + least(interval '15 minutes', interval '30 seconds' * power(2, l.failed_tries + 1 - 5))
                else null end
          where l.owner_id = p_user
          returning l.failed_tries, l.wait_until;
    end if;
  end
  $$;
revoke all on function public.lock_pin_attempt(uuid, boolean) from public, anon, authenticated;
grant execute on function public.lock_pin_attempt(uuid, boolean) to service_role;
