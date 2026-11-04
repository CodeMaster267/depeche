-- Import: bring old chats from ChatGPT, Claude and Gemini exports into a person's own private chats.
--
-- The browser reads the export zip (it never passes through Vercel whole) and sends the chats in
-- small batches to the server, which checks who is signed in and calls `import_chats` with the
-- service role. Imported replies are assistant messages, which the browser may never write itself.
--
-- Imported chats are ordinary chats owned by the person: row-level security already keeps them
-- private (a family admin sees at most the title, and only if the person shares titles), and both
-- chat searches find their messages. They keep their original dates, so they sort into the chat
-- list where they happened.
--
-- Storage: the database is on Supabase's free plan (500 MB). Each person may import up to 20 MB of
-- text, and imports stop for everyone once the whole database passes 400 MB, leaving room for
-- everyday chatting. Importing the same export again skips chats already brought in.

alter table public.chats
  add column imported_from text check (imported_from in ('chatgpt', 'claude', 'gemini')),
  add column import_key text check (import_key is null or char_length(import_key) between 1 and 200);

create unique index chats_import_key_idx on public.chats (owner_id, imported_from, import_key)
  where import_key is not null;

-- The import columns are written only by `import_chats`. The browser inserts chats with its own
-- session, so its insert policy now also requires them empty (it cannot update them at all).
drop policy chats_insert on public.chats;
create policy chats_insert on public.chats for insert to authenticated
  with check (owner_id = auth.uid() and imported_from is null and import_key is null);

create function public.import_text_limit() returns bigint language sql immutable as $$ select 20000000::bigint $$;
create function public.import_database_limit() returns bigint language sql immutable as $$ select 400000000::bigint $$;

-- Characters of imported text a person already has.
create function public.imported_chars(p_person uuid) returns bigint
  language sql stable security definer set search_path = ''
  as $$
    select coalesce(sum(char_length(m.content->>'text')), 0)::bigint
    from public.chats c join public.messages m on m.chat_id = c.id
    where c.owner_id = p_person and c.imported_from is not null
  $$;

-- Import a batch of chats for one person. `p_chats` is a JSON array of
--   {source, key, title, created_at, updated_at, messages: [{role, text, created_at, model}]}
-- already checked by the server. Returns {imported, skipped, full, used, limit}: `full` means the
-- person's allowance or the database ran out, and the chats from that one on were left out.
create function public.import_chats(p_owner uuid, p_chats jsonb) returns jsonb
  language plpgsql security definer set search_path = ''
  as $$
  declare
    used bigint := public.imported_chars(p_owner);
    lim bigint := public.import_text_limit();
    ch jsonb;
    size bigint;
    cid uuid;
    made integer := 0;
    skipped integer := 0;
    is_full boolean := false;
  begin
    if not exists (select 1 from public.profiles where id = p_owner) then
      raise exception 'No such person' using errcode = 'P0001';
    end if;
    if jsonb_typeof(p_chats) <> 'array' or jsonb_array_length(p_chats) > 200 then
      raise exception 'Send up to 200 chats at a time' using errcode = 'P0001';
    end if;
    if pg_database_size(current_database()) > public.import_database_limit() then
      return jsonb_build_object('imported', 0, 'skipped', 0, 'full', true, 'database_full', true, 'used', used, 'limit', lim);
    end if;

    for ch in select value from jsonb_array_elements(p_chats) loop
      if exists (
        select 1 from public.chats
        where owner_id = p_owner and imported_from = ch->>'source' and import_key = ch->>'key'
      ) then
        skipped := skipped + 1;
        continue;
      end if;

      select coalesce(sum(char_length(m->>'text')), 0) into size from jsonb_array_elements(ch->'messages') m;
      if used + size > lim then
        is_full := true;
        exit;
      end if;

      insert into public.chats (owner_id, title, imported_from, import_key, created_at, updated_at)
        values (
          p_owner,
          left(coalesce(nullif(btrim(ch->>'title'), ''), 'Imported chat'), 200),
          ch->>'source',
          ch->>'key',
          (ch->>'created_at')::timestamptz,
          (ch->>'updated_at')::timestamptz
        )
        returning id into cid;

      -- One straight line of messages, each the parent of the next. Equal times are nudged apart so
      -- the newest message is always the last one.
      insert into public.messages (id, chat_id, owner_id, parent_id, role, content, status, model, created_at)
        select s.id, cid, p_owner, lag(s.id) over (order by s.ord), s.role, jsonb_build_object('text', s.text),
               'completed', s.model, s.at + (s.ord * interval '1 microsecond')
        from (
          select gen_random_uuid() as id, e.ord, e.v->>'role' as role, e.v->>'text' as text,
                 nullif(left(e.v->>'model', 100), '') as model, (e.v->>'created_at')::timestamptz as at
          from jsonb_array_elements(ch->'messages') with ordinality as e (v, ord)
          where e.v->>'role' in ('user', 'assistant') and coalesce(e.v->>'text', '') <> ''
        ) s;

      used := used + size;
      made := made + 1;
    end loop;

    return jsonb_build_object('imported', made, 'skipped', skipped, 'full', is_full, 'database_full', false, 'used', used, 'limit', lim);
  end
  $$;

revoke all on function
  public.imported_chars(uuid), public.import_chats(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function
  public.imported_chars(uuid), public.import_chats(uuid, jsonb)
  to service_role;

-- Imported chats are kept until their owner deletes them: they are the person's history, brought in
-- on purpose, and the allowance above bounds their size. Everything else is unchanged.
create or replace function public.expire_old_chats() returns integer
  language plpgsql security definer set search_path = ''
  as $$
  declare
    n integer;
  begin
    delete from public.chats c
      using public.profiles p
      where p.id = c.owner_id
        and not p.keep_chats
        and not c.pinned
        and c.imported_from is null
        and c.updated_at < now() - interval '30 days';
    get diagnostics n = row_count;
    return n;
  end
  $$;
revoke all on function public.expire_old_chats() from public, anon, authenticated;
grant execute on function public.expire_old_chats() to service_role;
