-- Search your chats: the search box above the chat list finds words inside messages, not only
-- chat titles. It returns the best matching message of each of your chats, newest chats first
-- among equal matches, so the list can show a snippet and jump to that message.
--
-- Security invoker: it runs as the signed-in person, so row-level security on messages already
-- keeps it to their own words. The owner checks are repeated in the query anyway, on both the
-- messages and the chats, so a family admin (who can read members' chat titles) still finds
-- nothing of anyone else's, and the service role, with no person, finds nothing at all.
--
-- Matching is the same as search_chat: Postgres full-text search in English (stemmed) and word for
-- word (any language), plus a plain substring match for numbers and codes. Free on Supabase.
create or replace function public.search_my_chats(p_query text, p_limit int default 20)
returns table (chat_id uuid, message_id uuid, role text, created_at timestamptz, text text)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with q as (
    select
      nullif(btrim(p_query), '') as raw,
      nullif(replace(websearch_to_tsquery('english', p_query)::text, ' & ', ' | '), '')::tsquery as en,
      nullif(replace(websearch_to_tsquery('simple', p_query)::text, ' & ', ' | '), '')::tsquery as si,
      -- Every word must appear somewhere for the strongest match, so "boiler quote" ranks a
      -- message with both words above one with only "boiler".
      nullif(websearch_to_tsquery('english', p_query)::text, '')::tsquery as en_all
  ),
  hits as (
    select
      m.chat_id,
      m.id,
      m.role,
      m.created_at,
      m.content->>'text' as text,
      c.updated_at as chat_updated,
      case when q.en_all is not null and to_tsvector('english', m.content->>'text') @@ q.en_all then 2 else 0 end
        + coalesce(ts_rank(to_tsvector('english', m.content->>'text'), q.en), 0)
        + coalesce(ts_rank(to_tsvector('simple', m.content->>'text'), q.si), 0)
        + case when strpos(lower(m.content->>'text'), lower(q.raw)) > 0 then 1 else 0 end as rank
    from public.messages m
    join public.chats c on c.id = m.chat_id
    cross join q
    where m.owner_id = auth.uid()
      and c.owner_id = auth.uid()
      and c.archived_at is null
      and m.role in ('user', 'assistant')
      and coalesce(m.content->>'text', '') <> ''
      and q.raw is not null
      and char_length(q.raw) between 2 and 200
      and (
        (q.en is not null and to_tsvector('english', m.content->>'text') @@ q.en)
        or (q.si is not null and to_tsvector('simple', m.content->>'text') @@ q.si)
        or strpos(lower(m.content->>'text'), lower(q.raw)) > 0
      )
  ),
  best as (
    select distinct on (h.chat_id) h.*
    from hits h
    order by h.chat_id, h.rank desc, h.created_at desc
  )
  select b.chat_id, b.id, b.role, b.created_at, b.text
  from best b
  order by b.rank desc, b.chat_updated desc
  limit least(greatest(coalesce(p_limit, 20), 1), 30);
$$;

revoke all on function public.search_my_chats(text, int) from public, anon;
grant execute on function public.search_my_chats(text, int) to authenticated;
