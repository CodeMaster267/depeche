import "server-only";
import { cookies } from "next/headers";
import type { Me } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";
import { cleanSpec, type Spec } from "./spec";

/** Set by /safe: this device shows the standard look until it's turned off on My look. */
export const SAFE_COOKIE = "depeche-safe-look";

/** Hasan's app-wide switch, in Vercel's settings: DEPECHE_DESIGNS=off turns designs off for everyone. */
export function designsOffEverywhere(): boolean {
  return process.env.DEPECHE_DESIGNS === "off";
}

export type DesignRow = { id: string; name: string; spec: unknown; status: string; made_by: string | null; created_at: string; kept_at: string | null };
export type Look = {
  current: { id: string; spec: Spec } | null;
  /** A design the person's admin made for them, waiting for Keep or Undo. */
  offered: { id: string; spec: Spec; by: string } | null;
  safe: boolean;
  enabled: boolean;
};

export async function familyDesignsEnabled(familyId: string): Promise<boolean> {
  if (designsOffEverywhere()) return false;
  const { data } = await supabaseAdmin().from("design_settings").select("enabled").eq("family_id", familyId).maybeSingle<{ enabled: boolean }>();
  return data?.enabled ?? true;
}

/** The look to show this person now. Read with their own session, so they only ever get their own. */
export async function loadLook(me: Me): Promise<Look> {
  const safe = (await cookies()).get(SAFE_COOKIE)?.value === "1";
  const enabled = await familyDesignsEnabled(me.profile.family_id);
  if (!enabled) return { current: null, offered: null, safe, enabled };
  const db = await supabaseServer();
  const [{ data: cur }, { data: offered }] = await Promise.all([
    db.from("design_current").select("design_id").eq("owner_id", me.userId).maybeSingle<{ design_id: string | null }>(),
    db
      .from("designs")
      .select("id, spec, made_by")
      .eq("owner_id", me.userId)
      .eq("status", "offered")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string; spec: unknown; made_by: string | null }>(),
  ]);
  let current: Look["current"] = null;
  if (cur?.design_id) {
    const { data } = await db.from("designs").select("id, spec").eq("id", cur.design_id).maybeSingle<{ id: string; spec: unknown }>();
    if (data) current = { id: data.id, spec: cleanSpec(data.spec) };
  }
  let by = "Your family admin";
  if (offered?.made_by) {
    const { data: p } = await db.from("profiles").select("display_name").eq("id", offered.made_by).maybeSingle<{ display_name: string }>();
    if (p) by = p.display_name;
  }
  return { current, offered: offered ? { id: offered.id, spec: cleanSpec(offered.spec), by } : null, safe, enabled };
}

/** Builds used this month and builds allowed, for the meter. */
export async function buildMeter(personId: string): Promise<{ used: number; allowed: number }> {
  const admin = supabaseAdmin();
  const [{ data: used }, { data: allowed }] = await Promise.all([
    admin.rpc("design_builds_used", { p_person: personId }),
    admin.rpc("design_allowance", { p_person: personId }),
  ]);
  return { used: Number(used ?? 0), allowed: Number(allowed ?? 10) };
}

/** The 1st of next month, as people say it ("1 December"). */
export function resetDay(now = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
}
