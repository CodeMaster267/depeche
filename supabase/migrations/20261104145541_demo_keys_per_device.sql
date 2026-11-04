-- Demo keys now work once on each device rather than once for everyone (Hasan, 2026-11-04). Each
-- use is recorded against a keyed hash of a random id the browser keeps, so a device can't use the
-- same key twice. The old one-use-for-everyone function stays for code that's still deployed.

create table public.demo_key_uses (
  key_id uuid not null references public.demo_keys (id) on delete cascade,
  device_hash text not null check (length(device_hash) between 32 and 128),
  used_at timestamptz not null default now(),
  primary key (key_id, device_hash)
);

alter table public.demo_key_uses enable row level security;
revoke all on public.demo_key_uses from public, anon, authenticated;
grant select, insert, delete on public.demo_key_uses to service_role;

-- Uses a key on a device and says whether it worked. The insert is one statement, so the same
-- device trying the same key twice at once still gets in only once.
create function public.use_demo_key_on_device(p_hash text, p_device text) returns boolean
  language plpgsql security definer set search_path = public as $$
declare
  v_key uuid;
  v_done int;
begin
  select id into v_key from public.demo_keys where key_hash = p_hash;
  if v_key is null or p_device is null or length(p_device) < 32 then
    return false;
  end if;
  insert into public.demo_key_uses (key_id, device_hash) values (v_key, p_device)
  on conflict do nothing;
  get diagnostics v_done = row_count;
  if v_done = 1 then
    update public.demo_keys set used_at = coalesce(used_at, now()) where id = v_key;
  end if;
  return v_done = 1;
end $$;
revoke all on function public.use_demo_key_on_device(text, text) from public, anon, authenticated;
grant execute on function public.use_demo_key_on_device(text, text) to service_role;
