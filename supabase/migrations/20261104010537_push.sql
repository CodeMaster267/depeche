-- Web Push: a note on your phone or computer when an answer finishes after you've left the app.
--
--   * push_subscriptions: one row per browser or home-screen app that turned notifications on.
--     Only the server adds rows (it checks the address belongs to a real push service first), so
--     the browser can never make the server send requests somewhere else. You can see and remove
--     your own; nobody else, admins included, can see them.
--   * push_away: "I left while this answer was being written." The app marks it when it goes into
--     the background mid-answer and clears it when it comes back. When the answer is saved, the
--     server sends a notification only if the mark is there, so nobody is pinged while watching.

create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  endpoint    text not null unique check (char_length(endpoint) between 1 and 1000),
  p256dh      text not null check (char_length(p256dh) between 1 and 200),
  auth        text not null check (char_length(auth) between 1 and 100),
  device      text check (char_length(device) <= 200),
  created_at  timestamptz not null default now()
);
create index push_subscriptions_owner_idx on public.push_subscriptions (owner_id);

create table public.push_away (
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  request_id  uuid not null,
  created_at  timestamptz not null default now(),
  primary key (owner_id, request_id)
);

revoke all on public.push_subscriptions, public.push_away from anon, authenticated;
grant select (id, owner_id, device, created_at) on public.push_subscriptions to authenticated;
grant delete                                    on public.push_subscriptions to authenticated;
grant select, insert, delete                    on public.push_away          to authenticated;

alter table public.push_subscriptions enable row level security;
alter table public.push_away          enable row level security;

create policy push_subscriptions_select on public.push_subscriptions for select to authenticated
  using (owner_id = auth.uid());
create policy push_subscriptions_delete on public.push_subscriptions for delete to authenticated
  using (owner_id = auth.uid());

create policy push_away_select on public.push_away for select to authenticated
  using (owner_id = auth.uid());
create policy push_away_insert on public.push_away for insert to authenticated
  with check (owner_id = auth.uid());
create policy push_away_delete on public.push_away for delete to authenticated
  using (owner_id = auth.uid());

-- Marks left behind (the answer failed to save, or the app came back too late) go in the daily clean-up.
create function public.expire_push_away() returns integer
  language plpgsql security definer set search_path = ''
  as $$
  declare
    n integer;
  begin
    delete from public.push_away where created_at < now() - interval '1 day';
    get diagnostics n = row_count;
    return n;
  end
  $$;
revoke all on function public.expire_push_away() from public, anon, authenticated;
grant execute on function public.expire_push_away() to service_role;
