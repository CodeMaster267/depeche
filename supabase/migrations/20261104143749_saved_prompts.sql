-- Saved prompts: a person's own reusable messages, optionally with {{blanks}} to fill in when
-- used. Private to their owner like memories: a family admin and the app owner see none of them,
-- not even titles.

create table public.saved_prompts (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 80),
  body        text not null check (char_length(body) between 1 and 8000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index saved_prompts_owner_idx on public.saved_prompts (owner_id, updated_at desc);

-- Supabase grants everything by default; take it back and grant only what the app needs.
revoke all on public.saved_prompts from anon, authenticated;
grant select, insert, delete on public.saved_prompts to authenticated;
grant update (title, body, updated_at) on public.saved_prompts to authenticated;

alter table public.saved_prompts enable row level security;

create policy saved_prompts_select on public.saved_prompts for select to authenticated
  using (owner_id = auth.uid());
create policy saved_prompts_insert on public.saved_prompts for insert to authenticated
  with check (owner_id = auth.uid());
create policy saved_prompts_update on public.saved_prompts for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy saved_prompts_delete on public.saved_prompts for delete to authenticated
  using (owner_id = auth.uid());

-- No more than 200 each, so one account can't fill the free database.
create function public.saved_prompts_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.saved_prompts where owner_id = new.owner_id) >= 200 then
    raise exception 'You can save up to 200 prompts' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.saved_prompts_limit() from public, anon, authenticated;

create trigger saved_prompts_limit before insert on public.saved_prompts
  for each row execute function public.saved_prompts_limit();
