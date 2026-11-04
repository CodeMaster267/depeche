"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { friendly, requireMe } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { SAFE_COOKIE } from "@/lib/design/load";

/**
 * Keep, Undo, history, reset and safe mode for a person's own design, and the admin's settings.
 * All written by the server after checking who is asking: designs are read-only to the browser.
 */

async function ownDesign(id: string) {
  const me = await requireMe();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await supabaseAdmin().from("designs").select("id, owner_id, status").eq("id", id).maybeSingle<{ id: string; owner_id: string; status: string }>();
  return data && data.owner_id === me.userId ? { me, design: data } : null;
}

/** Keep a design (a new one, one from the history, or one an admin made for you). */
export async function keepDesign(id: string): Promise<{ ok: boolean }> {
  const found = await ownDesign(id);
  if (!found) return { ok: false };
  const admin = supabaseAdmin();
  const now = new Date().toISOString();
  await admin.from("designs").update({ status: "kept", kept_at: now }).eq("id", id);
  await admin.from("design_current").upsert({ owner_id: found.me.userId, design_id: id, updated_at: now });
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Undo a design that was only being previewed. A kept one stays in the history. */
export async function undoDesign(id: string): Promise<{ ok: boolean }> {
  const found = await ownDesign(id);
  if (!found) return { ok: false };
  if (found.design.status === "preview" || found.design.status === "offered") {
    await supabaseAdmin().from("designs").update({ status: "undone" }).eq("id", id);
  }
  revalidatePath("/design");
  return { ok: true };
}

/** Back to standard Depeche. The designs stay in the history. */
export async function resetDesign(): Promise<void> {
  const me = await requireMe();
  await supabaseAdmin().from("design_current").upsert({ owner_id: me.userId, design_id: null, updated_at: new Date().toISOString() });
  revalidatePath("/", "layout");
}

/** Remove a design from the history (not the one in use). */
export async function deleteDesign(id: string): Promise<void> {
  const found = await ownDesign(id);
  if (!found) return;
  const admin = supabaseAdmin();
  const { data: cur } = await admin.from("design_current").select("design_id").eq("owner_id", found.me.userId).maybeSingle<{ design_id: string | null }>();
  if (cur?.design_id === id) return;
  await admin.from("designs").delete().eq("id", id);
  revalidatePath("/design");
}

/** Safe mode, on this device only: the standard look, whatever the design. */
export async function setSafeMode(on: boolean): Promise<void> {
  await requireMe();
  const jar = await cookies();
  if (on) jar.set(SAFE_COOKIE, "1", { path: "/", httpOnly: true, sameSite: "lax", secure: !!process.env.VERCEL, maxAge: 60 * 60 * 24 * 365 });
  else jar.delete(SAFE_COOKIE);
  revalidatePath("/", "layout");
}

export type AdminState = { error?: string; ok?: string } | undefined;

/** Family admins: the kill switch and the family's builds per month. */
export async function saveDesignSettings(_: AdminState, form: FormData): Promise<AdminState> {
  const me = await requireMe();
  const builds = Number(String(form.get("builds") ?? "").trim());
  if (!Number.isInteger(builds)) return { error: "Enter a whole number of builds." };
  const { error } = await supabaseAdmin().rpc("set_design_settings", { p_actor: me.userId, p_enabled: form.get("enabled") === "on", p_builds: builds });
  if (error) return { error: friendly(error, "Couldn't save that.") };
  revalidatePath("/", "layout");
  return { ok: "Saved." };
}

/** Family admins: one member's builds per month (empty goes back to the family's number). */
export async function saveMemberBuilds(_: AdminState, form: FormData): Promise<AdminState> {
  const me = await requireMe();
  const member = String(form.get("member") ?? "");
  const raw = String(form.get("builds") ?? "").trim();
  const builds = raw === "" ? null : Number(raw);
  if (builds !== null && !Number.isInteger(builds)) return { error: "Enter a whole number, or leave it empty for the family's number." };
  const { error } = await supabaseAdmin().rpc("set_design_allowance", { p_actor: me.userId, p_member: member, p_builds: builds });
  if (error) return { error: friendly(error, "Couldn't save that.") };
  revalidatePath("/family/designs");
  return { ok: "Saved." };
}
