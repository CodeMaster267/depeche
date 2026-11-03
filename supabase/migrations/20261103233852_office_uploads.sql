-- Word, Excel and PowerPoint files can be attached too. The server reads their text for the model
-- (lib/docs/read.ts), since no provider takes them directly. Same private bucket, same 10 MB cap.

update storage.buckets
set allowed_mime_types = array[
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
]
where id = 'uploads';
