-- "Search this chat": a tool the model can call to find the exact wording of earlier messages in
-- the chat it is answering, once older messages have been summarised or left out.
--
-- Security invoker: the server calls it as the person chatting, so row-level security on
-- messages decides what it can see (their own messages only). The owner check is repeated here so
-- the function stays private even if someone later calls it as the service role by mistake:
-- with no signed-in person, auth.uid() is null and nothing matches. Family admins and the app
-- owner can never read anyone else's messages through it.
--
-- Matching is Postgres full-text search (free), in English (so "boilers" finds "boiler") and
-- word for word (any language), plus a plain substring match so numbers, codes and short
-- fragments like "£450" or "B-12" are found too. Terms are ORed and ranked, so a message with
-- more of the words comes first.
create or replace function public.search_chat(
  p_chat uuid,
  p_query text,
  p_messages uuid[] default null,
  p_limit int default 8
)
returns table (id uuid, role text, created_at timestamptz, text text)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with q as (
    select
      nullif(btrim(p_query), '') as raw,
      nullif(replace(websearch_to_tsquery('english', p_query)::text, ' & ', ' | '), '')::tsquery as en,
      nullif(replace(websearch_to_tsquery('simple', p_query)::text, ' & ', ' | '), '')::tsquery as si
  ),
  hits as (
    select
      m.id,
      m.role,
      m.created_at,
      m.content->>'text' as text,
      coalesce(ts_rank(to_tsvector('english', m.content->>'text'), q.en), 0)
        + coalesce(ts_rank(to_tsvector('simple', m.content->>'text'), q.si), 0)
        + case when strpos(lower(m.content->>'text'), lower(q.raw)) > 0 then 1 else 0 end as rank
    from public.messages m, q
    where m.chat_id = p_chat
      and m.owner_id = auth.uid()
      and (p_messages is null or m.id = any (p_messages))
      and m.role in ('user', 'assistant')
      and coalesce(m.content->>'text', '') <> ''
      and q.raw is not null
      and length(q.raw) <= 500
      and (
        (q.en is not null and to_tsvector('english', m.content->>'text') @@ q.en)
        or (q.si is not null and to_tsvector('simple', m.content->>'text') @@ q.si)
        or strpos(lower(m.content->>'text'), lower(q.raw)) > 0
      )
  )
  select h.id, h.role, h.created_at, h.text
  from hits h
  order by h.rank desc, h.created_at
  limit least(greatest(coalesce(p_limit, 8), 1), 20);
$$;

revoke all on function public.search_chat(uuid, text, uuid[], int) from public, anon;
grant execute on function public.search_chat(uuid, text, uuid[], int) to authenticated;
