import { NextResponse, type NextRequest } from "next/server";
import { getMe } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Stops the person's own research. A step in progress notices within a few seconds and stops too. */
export async function POST(req: NextRequest) {
  const me = await getMe();
  if (!me) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "No such research." }, { status: 404 });
  const { error } = await supabaseAdmin()
    .from("research_runs")
    .update({ status: "stopped", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("owner_id", me.userId)
    .eq("status", "running");
  if (error) return NextResponse.json({ error: "Couldn't stop it. Try again." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
