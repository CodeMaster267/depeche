-- Personal instructions: what each person tells Depeche about themselves and how they want answers
-- written (like ChatGPT's custom instructions). Given to every model with every message.
-- Private like memories: only the person themselves can read or change them; family admins and
-- the app owner cannot.

create table public.personal_instructions (
  owner_id     uuid primary key references public.profiles (id) on delete cascade,
  about_me     text not null default '' check (char_length(about_me) <= 1500),
  answer_style text not null default '' check (char_length(answer_style) <= 1500),
  enabled      boolean not null default true,
  updated_at   timestamptz not null default now()
);

-- Supabase grants everything on new tables by default; take it back and grant only what's needed.
revoke all on public.personal_instructions from public, anon, authenticated;
grant select, insert, delete                                  on public.personal_instructions to authenticated;
grant update (about_me, answer_style, enabled, updated_at)    on public.personal_instructions to authenticated;

alter table public.personal_instructions enable row level security;

create policy personal_instructions_select on public.personal_instructions for select to authenticated
  using (owner_id = auth.uid());
create policy personal_instructions_insert on public.personal_instructions for insert to authenticated
  with check (owner_id = auth.uid());
create policy personal_instructions_update on public.personal_instructions for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy personal_instructions_delete on public.personal_instructions for delete to authenticated
  using (owner_id = auth.uid());
