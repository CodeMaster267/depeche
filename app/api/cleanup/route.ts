import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { UPLOAD_BUCKET } from "@/lib/chat/files";
import { VOICE_NOTE_BUCKET } from "@/lib/voice/notes";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily clean-up, run by Vercel Cron. Deletes chats unused for a month (unless pinned, or their
 * owner chose to keep chats), then uploaded files whose chat hasn't been used for 3 days, and
 * uploads that were never sent, and recordings left waiting to be written out for over a day.
 *
 * It only ever deletes what is already due, so running it early does no harm. When CRON_SECRET is
 * set in Vercel, only Vercel's scheduler can run it.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Not allowed" }, { status: 401 });
  }
  const admin = supabaseAdmin();
  const { data: chats, error: chatError } = await admin.rpc("expire_old_chats");
  if (chatError) return NextResponse.json({ error: chatError.message }, { status: 500 });
  let files = 0;
  for (let round = 0; round < 10; round++) {
    const { data, error } = await admin.rpc("expired_uploads", { p_limit: 500 });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const paths = (data as string[] | null) ?? [];
    if (!paths.length) break;
    for (let i = 0; i < paths.length; i += 100) {
      const { error: removeError } = await admin.storage.from(UPLOAD_BUCKET).remove(paths.slice(i, i + 100));
      if (removeError) return NextResponse.json({ error: removeError.message, chats, files }, { status: 500 });
      files += Math.min(100, paths.length - i);
    }
  }
  // Recordings are normally deleted the moment they're written out; these were left behind.
  let recordings = 0;
  for (let round = 0; round < 5; round++) {
    const { data, error } = await admin.rpc("expired_voice_notes", { p_limit: 100 });
    if (error) return NextResponse.json({ error: error.message, chats, files }, { status: 500 });
    const paths = (data as string[] | null) ?? [];
    if (!paths.length) break;
    const { error: removeError } = await admin.storage.from(VOICE_NOTE_BUCKET).remove(paths);
    if (removeError) return NextResponse.json({ error: removeError.message, chats, files }, { status: 500 });
    recordings += paths.length;
  }
  return NextResponse.json({ chats, files, recordings });
}
