-- Files people attach to messages.
--
-- The browser uploads straight to a private storage bucket (Vercel can't take bodies over 4.5 MB),
-- into a folder named after the person's own id. Storage row-level security lets each person
-- reach only their own folder. A message lists its files in `content.files` by path; the server
-- checks each path starts with the sender's id before reading it.
--
-- Files are deleted once their chat has gone unused for 3 days, and uploads that were never sent
-- after a day. The server does the deleting through the storage API, so the files really go.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('uploads', 'uploads', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "uploads: read own" on storage.objects for select to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "uploads: add own" on storage.objects for insert to authenticated
  with check (bucket_id = 'uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "uploads: remove own" on storage.objects for delete to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Paths of uploads that are due to be deleted.
create function public.expired_uploads(p_limit int default 1000) returns setof text
  language sql stable security definer set search_path = ''
  as $$
    select o.name from storage.objects o
    where o.bucket_id = 'uploads'
      and o.created_at < now() - interval '1 day'
      and not exists (
        select 1 from public.messages m join public.chats c on c.id = m.chat_id
        where c.updated_at > now() - interval '3 days'
          and m.content -> 'files' @> jsonb_build_array(jsonb_build_object('path', o.name))
      )
    order by o.created_at
    limit p_limit
  $$;
revoke all on function public.expired_uploads(int) from public, anon, authenticated;
grant execute on function public.expired_uploads(int) to service_role;
