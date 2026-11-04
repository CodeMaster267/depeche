import { NextResponse, type NextRequest } from "next/server";
import { getMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The chat screen calls this when it goes into the background while an answer is being written
 * (away: true) and when it comes back (away: false). Written with the person's own session, so
 * row-level security keeps each mark theirs.
 */
export async function POST(req: NextRequest) {
  const me = await getMe();
  if (!me) return NextResponse.json({ error: "Sign in again first." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { requestId?: unknown; away?: unknown };
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  if (!UUID.test(requestId)) return NextResponse.json({ error: "Not found." }, { status: 400 });
  const db = await supabaseServer();
  if (body.away === true) {
    const { error } = await db.from("push_away").insert({ owner_id: me.userId, request_id: requestId });
    // Already marked is fine.
    if (error && error.code !== "23505") return NextResponse.json({ error: "Couldn't save that." }, { status: 500 });
  } else {
    await db.from("push_away").delete().eq("owner_id", me.userId).eq("request_id", requestId);
  }
  return NextResponse.json({ ok: true });
}
