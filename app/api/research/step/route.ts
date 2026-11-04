import { NextResponse, after, type NextRequest } from "next/server";
import { getMe } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { advance, validChainToken } from "@/lib/research/run";

// Each step works for up to about four and a half minutes, after this request has been answered.
export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs the next step of a research run. Called by the server itself when a step hands over (proved
 * with a key only the server knows), or by the run's owner when their open chat sees it has stalled.
 * Either way the step only runs if the run is still going and no other step holds it.
 */
export async function POST(req: NextRequest) {
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id || !UUID.test(id)) return NextResponse.json({ error: "No such research." }, { status: 404 });
  if (!validChainToken(id, req.headers.get("x-depeche-research"))) {
    const me = await getMe();
    if (!me) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
    const { data: mine } = await supabaseAdmin().from("research_runs").select("id").eq("id", id).eq("owner_id", me.userId).maybeSingle();
    if (!mine) return NextResponse.json({ error: "No such research." }, { status: 404 });
  }
  const origin = req.nextUrl.origin;
  after(() => advance(id, origin));
  return NextResponse.json({ ok: true }, { status: 202 });
}
