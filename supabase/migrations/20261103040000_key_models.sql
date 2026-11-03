-- Which models each family key can actually use.
--
-- When a key is saved, and about once a day after that, the server asks the provider which models
-- the key can see and stores the ones Depeche offers. The app then hides the rest. `models` is null
-- until the first check. Members learn only model names, never anything about the key itself.

alter table public.provider_keys
  add column models text[] check (models is null or cardinality(models) <= 200),
  add column models_checked_at timestamptz;

-- The caller's family providers, with the models each key can use (null: not checked yet).
create function public.family_models() returns table (provider text, models text[], checked_at timestamptz)
  language sql stable security definer set search_path = ''
  as $$
    select k.provider, k.models, k.models_checked_at from public.provider_keys k
    where k.family_id = (select family_id from public.profiles where id = auth.uid())
    order by k.provider
  $$;
revoke all on function public.family_models() from public, anon;
grant execute on function public.family_models() to authenticated;

-- Record the result of a check. Server only; it has already confirmed whose family this is.
create function public.set_key_models(p_family uuid, p_provider text, p_models text[]) returns void
  language sql security definer set search_path = ''
  as $$
    update public.provider_keys set models = p_models, models_checked_at = now()
    where family_id = p_family and provider = p_provider
  $$;
revoke all on function public.set_key_models(uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.set_key_models(uuid, text, text[]) to service_role;
