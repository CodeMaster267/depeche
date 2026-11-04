import { NextResponse, type NextRequest } from "next/server";
import { getMe } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { allow } from "@/lib/rate-limit";
import { isPushEndpoint } from "@/lib/push/server";

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });
/** Phones, tablets and computers one person can have notifications on. */
const MAX_DEVICES = 10;
const B64URL = /^[A-Za-z0-9_-]+=*$/;

type Body = { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; device?: unknown };

/**
 * Turns notifications on for this device (POST) or off (DELETE). Only the server stores the
 * address, after checking it belongs to a real push service.
 */
export async function POST(req: NextRequest) {
  const me = await getMe();
  if (!me) return fail(401, "Sign in again first.");
  if (!(await allow(["pushChanges", me.userId]))) return fail(429, "Try again in a little while.");
  const body = (await req.json().catch(() => ({}))) as Body;
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body.keys?.auth === "string" ? body.keys.auth : "";
  if (endpoint.length > 1000 || !isPushEndpoint(endpoint)) return fail(400, "This browser's notifications can't be used.");
  if (!B64URL.test(p256dh) || p256dh.length > 200 || !B64URL.test(auth) || auth.length > 100) {
    return fail(400, "This browser's notifications can't be used.");
  }
  const device = typeof body.device === "string" ? body.device.slice(0, 200) : null;

  const admin = supabaseAdmin();
  // A shared computer moves to whoever turned notifications on last.
  const { error } = await admin
    .from("push_subscriptions")
    .upsert({ owner_id: me.userId, endpoint, p256dh, auth, device, created_at: new Date().toISOString() }, { onConflict: "endpoint" });
  if (error) return fail(500, "Couldn't turn notifications on. Try again.");

  const { data: mine } = await admin
    .from("push_subscriptions")
    .select("id")
    .eq("owner_id", me.userId)
    .order("created_at", { ascending: false });
  const extra = (mine ?? []).slice(MAX_DEVICES).map((r) => r.id as string);
  if (extra.length) await admin.from("push_subscriptions").delete().in("id", extra);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const me = await getMe();
  if (!me) return fail(401, "Sign in again first.");
  const body = (await req.json().catch(() => ({}))) as Body;
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  if (!endpoint) return fail(400, "Nothing to turn off.");
  await supabaseAdmin().from("push_subscriptions").delete().eq("owner_id", me.userId).eq("endpoint", endpoint);
  return NextResponse.json({ ok: true });
}
