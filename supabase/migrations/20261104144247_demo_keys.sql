-- One-time demo keys: a word the app owner hands out that signs someone into the owner's account
-- once, in a limited demo session. Only keyed hashes are stored (HMAC with a server secret), never
-- the words, because the repository is public and dictionary words are easy to guess. Nobody who
-- is signed in can read or write this table; only the server can, through the functions below.

create table public.demo_keys (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null unique check (length(key_hash) between 32 and 128),
  added_by uuid not null references public.profiles (id) on delete cascade,
  added_at timestamptz not null default now(),
  used_at timestamptz
);

alter table public.demo_keys enable row level security;
-- Supabase grants everything on new tables by default; take it back.
revoke all on public.demo_keys from public, anon, authenticated;
grant select, insert, update, delete on public.demo_keys to service_role;

-- Burns a key and says whether it was good. The update is a single statement, so two people
-- typing the same key at the same moment can't both get in.
create function public.use_demo_key(p_hash text) returns boolean
  language sql security definer set search_path = public as $$
  with burned as (
    update public.demo_keys set used_at = now()
    where key_hash = p_hash and used_at is null
    returning id
  )
  select exists (select 1 from burned)
$$;
revoke all on function public.use_demo_key(text) from public, anon, authenticated;
grant execute on function public.use_demo_key(text) to service_role;

-- Adds a key. Only the app owner can, because a key signs into the owner's own account.
create function public.add_demo_key(p_actor uuid, p_hash text) returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from public.profiles where id = p_actor and is_app_owner) then
    raise exception 'Only the app owner can add demo keys';
  end if;
  if (select count(*) from public.demo_keys where used_at is null) >= 10 then
    raise exception 'You already have 10 unused demo keys';
  end if;
  insert into public.demo_keys (key_hash, added_by) values (p_hash, p_actor)
  on conflict (key_hash) do nothing
  returning id into v_id;
  if v_id is null then
    raise exception 'That demo key was already added';
  end if;
  return v_id;
end $$;
revoke all on function public.add_demo_key(uuid, text) from public, anon, authenticated;
grant execute on function public.add_demo_key(uuid, text) to service_role;
