-- Chat: provider keys, model choice, spending.
--
-- Provider keys arrive from the family admin through the server, which encrypts them before they
-- reach this database. Only the server may store, replace or remove a key, and only for a family
-- the acting person is admin of. Members never see keys, not even the last four characters; they
-- only learn which providers their family has, so the app can offer those models.
--
-- Assistant messages and usage are written by the server (service role) after each reply, so the
-- browser still cannot create either.

-- The model a person last chose, so a new chat on any device starts with it.
alter table public.profiles
  add column last_model text check (last_model is null or char_length(last_model) between 1 and 100);
grant update (last_model) on public.profiles to authenticated;

-- Which providers the caller's family has a key for. Names only.
create function public.family_providers() returns setof text
  language sql stable security definer set search_path = ''
  as $$
    select k.provider from public.provider_keys k
    where k.family_id = (select family_id from public.profiles where id = auth.uid())
    order by k.provider
  $$;
revoke all on function public.family_providers() from public, anon;
grant execute on function public.family_providers() to authenticated;

-- Store or replace a family's key for one provider. `p_ciphertext` is already encrypted.
create function public.save_provider_key(p_actor uuid, p_provider text, p_ciphertext bytea, p_last4 text)
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
  end
  $$;

create function public.remove_provider_key(p_actor uuid, p_provider text) returns void
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if not exists (select 1 from public.profiles where id = p_actor and role = 'admin') then
      raise exception 'Only a family admin can remove keys' using errcode = 'P0001';
    end if;
    delete from public.provider_keys
      where provider = p_provider
        and family_id = (select family_id from public.profiles where id = p_actor);
  end
  $$;

-- What a person has spent since the start of this calendar month (UTC), in dollars.
create function public.month_spend(p_person uuid) returns numeric
  language sql stable security definer set search_path = ''
  as $$
    select coalesce(sum(cost_usd), 0) from public.usage_events
    where owner_id = p_person and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
  $$;

revoke all on function
  public.save_provider_key(uuid, text, bytea, text), public.remove_provider_key(uuid, text),
  public.month_spend(uuid)
  from public, anon, authenticated;
grant execute on function
  public.save_provider_key(uuid, text, bytea, text), public.remove_provider_key(uuid, text),
  public.month_spend(uuid)
  to service_role;

-- The chat list is read newest first, and the messages of one chat in order.
create index if not exists messages_chat_parent_idx on public.messages (parent_id);
