import { NextResponse, type NextRequest } from "next/server";
import { getMe } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { allow } from "@/lib/rate-limit";
import { MAX_BODY_CHARS, validateBatch } from "@/lib/import/types";

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

export type ImportResponse = { imported: number; skipped: number; full: boolean; database_full: boolean; used: number; limit: number };

/**
 * One batch of chats from another app's export, read by the browser. Imported replies are
 * assistant messages, which only the server may write, so the batch is checked here and stored by
 * `import_chats` for the signed-in person only.
 */
export async function POST(req: NextRequest) {
  const me = await getMe();
  if (!me) return fail(401, "Sign in again to import chats.");
  if (me.profile.must_change_password) return fail(403, "Choose a new password first, in Account.");
  if (!(await allow(["importBatches", me.userId]))) {
    return fail(429, "That's a lot of importing for one hour. Try again later; chats already brought in are kept.");
  }
  const text = await req.text().catch(() => "");
  if (!text || text.length > MAX_BODY_CHARS) return fail(413, "That batch is too big.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "Something went wrong. Try again.");
  }
  const chats = validateBatch(body);
  if (!chats) return fail(400, "Some of those chats couldn't be read. Try the export again.");

  const { data, error } = await supabaseAdmin().rpc("import_chats", { p_owner: me.userId, p_chats: chats });
  if (error) return fail(500, "Couldn't save those chats. Try again.");
  return NextResponse.json(data as ImportResponse);
}
