-- The Health screen. A family admin sees their own family's health; the app owner also sees the
-- system's. Everything here is counts and dates, never what anyone wrote.
--
-- Both functions take the acting person's id and check it themselves, and only the server may call
-- them, the same as every other admin function.

-- One family's health: each provider key, which models it can use, and how its replies went in the
-- last 24 hours (counted from reply status only, never content), plus the month's spending.
create function public.family_health(p_actor uuid)
  returns table (
    provider text,
    models text[],
    checked_at timestamptz,
    replies_24h integer,
    failed_24h integer,
    last_ok timestamptz,
    last_error_at timestamptz
  )
  language plpgsql stable security definer set search_path = ''
  as $$
  declare
    fam uuid;
  begin
    select family_id into fam from public.profiles where id = p_actor and role = 'admin';
    if fam is null then
      raise exception 'Only a family admin can see its health' using errcode = 'P0001';
    end if;
    return query
      select k.provider, k.models, k.models_checked_at,
             count(m.id) filter (where m.created_at > now() - interval '24 hours')::integer,
             count(m.id) filter (where m.created_at > now() - interval '24 hours' and m.status = 'failed')::integer,
             max(m.created_at) filter (where m.status = 'completed'),
             max(m.created_at) filter (where m.status = 'failed')
      from public.provider_keys k
      left join public.messages m
        on m.role = 'assistant' and m.provider = k.provider and m.created_at > now() - interval '30 days'
       and m.owner_id in (select p.id from public.profiles p where p.family_id = fam)
      where k.family_id = fam
      group by k.provider, k.models, k.models_checked_at
      order by k.provider;
  end
  $$;

-- The last result of each scheduled job (backup, restore test, keep-alive, health check). These
-- are about the whole system, hold no family data, and any family admin may see them: a backup
-- protects everyone's chats.
create function public.latest_checks(p_actor uuid)
  returns table (kind text, ok boolean, detail text, created_at timestamptz, last_ok_at timestamptz)
  language plpgsql stable security definer set search_path = ''
  as $$
  begin
    if not exists (select 1 from public.profiles where id = p_actor and role = 'admin') then
      raise exception 'Only a family admin can see its health' using errcode = 'P0001';
    end if;
    return query
      select distinct on (c.kind) c.kind, c.ok, c.detail, c.created_at,
             (select max(x.created_at) from public.system_checks x where x.kind = c.kind and x.ok)
      from public.system_checks c
      order by c.kind, c.created_at desc;
  end
  $$;

-- The system, for the app owner only: sizes and totals across every family, with no family named
-- and no spending (the owner sees nothing of other families' money).
create function public.system_health(p_actor uuid)
  returns table (
    families integer,
    people integer,
    database_bytes bigint,
    replies_24h integer,
    failed_24h integer,
    open_holds integer,
    last_backup_at timestamptz,
    last_backup_bytes bigint,
    last_backup_restore_verified boolean
  )
  language plpgsql stable security definer set search_path = ''
  as $$
  begin
    if not exists (select 1 from public.profiles where id = p_actor and is_app_owner) then
      raise exception 'Only the owner can see the system''s health' using errcode = 'P0001';
    end if;
    return query
      select (select count(*) from public.families)::integer,
             (select count(*) from public.profiles)::integer,
             pg_database_size(current_database()),
             (select count(*) from public.messages where role = 'assistant' and created_at > now() - interval '24 hours')::integer,
             (select count(*) from public.messages where role = 'assistant' and status = 'failed' and created_at > now() - interval '24 hours')::integer,
             (select count(*) from public.spend_holds where expires_at > now())::integer,
             b.finished_at, b.size_bytes, b.restore_verified
      from (select 1) one
      left join lateral (select * from public.backup_runs order by finished_at desc limit 1) b on true;
  end
  $$;

-- Provider failures across the system in the last 24 hours, by provider only. The daily health
-- check in GitHub Actions reads this to email Hasan when a provider keeps failing.
create function public.provider_failures_24h()
  returns table (provider text, replies integer, failed integer)
  language sql stable security definer set search_path = ''
  as $$
    select m.provider, count(*)::integer, count(*) filter (where m.status = 'failed')::integer
    from public.messages m
    where m.role = 'assistant' and m.provider is not null and m.created_at > now() - interval '24 hours'
    group by m.provider order by m.provider
  $$;

revoke all on function
  public.family_health(uuid), public.latest_checks(uuid), public.system_health(uuid), public.provider_failures_24h()
  from public, anon, authenticated;
grant execute on function
  public.family_health(uuid), public.latest_checks(uuid), public.system_health(uuid), public.provider_failures_24h()
  to service_role;
