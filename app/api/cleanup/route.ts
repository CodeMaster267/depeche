import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { UPLOAD_BUCKET } from "@/lib/chat/files";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily clean-up, run by Vercel Cron. Deletes chats unused for a month (unless pinned, or their
 * owner chose to keep chats), then uploaded files whose chat hasn't been used for 3 days, and
 * uploads that were never sent.
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
  // Leftover "away" marks for notifications (see lib/push/notify.ts).
  await admin.rpc("expire_push_away");
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
  return NextResponse.json({ chats, files });
}
