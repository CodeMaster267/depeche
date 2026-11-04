-- Voice notes and other recordings, waiting to be written out.
--
-- The browser uploads a recording straight to this private bucket (Vercel can't take bodies over
-- 4.5 MB), into a folder named after the person's own id, then asks the server to write it out.
-- The server deletes the recording as soon as it has read it; only the transcript is kept, as an
-- ordinary upload. Anything left behind (a closed tab, say) is deleted by the daily clean-up after
-- a day.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('voice-notes', 'voice-notes', false, 26214400,
        array['audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/aac', 'audio/flac'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "voice notes: read own" on storage.objects for select to authenticated
  using (bucket_id = 'voice-notes' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "voice notes: add own" on storage.objects for insert to authenticated
  with check (bucket_id = 'voice-notes' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "voice notes: remove own" on storage.objects for delete to authenticated
  using (bucket_id = 'voice-notes' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Recordings older than a day, which nobody is still waiting on.
create function public.expired_voice_notes(p_limit int default 1000) returns setof text
  language sql stable security definer set search_path = ''
  as $$
    select o.name from storage.objects o
    where o.bucket_id = 'voice-notes' and o.created_at < now() - interval '1 day'
    order by o.created_at
    limit p_limit
  $$;
revoke all on function public.expired_voice_notes(int) from public, anon, authenticated;
grant execute on function public.expired_voice_notes(int) to service_role;
