"use server";

import { revalidatePath } from "next/cache";
import { getMe } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { allow } from "@/lib/rate-limit";
import { MAX_WIDGET } from "@/lib/widgets/frame";
import { MAX_SAVE, cleanTitle, createGadget, saveVersion } from "@/lib/gadgets/store";
import { askableModels, familyKeys } from "@/lib/gadgets/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Result = { ok: true; id?: string } | { ok: false; error: string };

async function me() {
  const m = await getMe();
  if (!m) throw new Error("Sign in again.");
  return m;
}

/** The person's own gadget, or null. */
async function own(userId: string, id: unknown) {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const { data } = await supabaseAdmin()
    .from("gadgets")
    .select("id, title, html")
    .eq("id", id)
    .eq("owner_id", userId)
    .maybeSingle<{ id: string; title: string; html: string }>();
  return data;
}

/** Saves a gadget from a reply to My gadgets. */
export async function saveGadget(title: string, html: string, chatId: string | null): Promise<Result> {
  const m = await me();
  if (typeof html !== "string" || !html.trim() || html.length > MAX_WIDGET) return { ok: false, error: "This gadget can't be saved." };
  if (!(await allow(["adminActions", m.userId]))) return { ok: false, error: "That's a lot at once. Wait a minute and try again." };
  let chat: string | null = null;
  if (typeof chatId === "string" && UUID.test(chatId)) {
    const { data } = await supabaseAdmin().from("chats").select("id").eq("id", chatId).eq("owner_id", m.userId).maybeSingle();
    chat = data ? chatId : null;
  }
  const r = await createGadget(m.userId, String(title ?? ""), html, { chatId: chat });
  if ("error" in r) return { ok: false, error: r.error ?? "Couldn't save the gadget." };
  revalidatePath("/gadgets");
  return { ok: true, id: r.id };
}

export async function deleteGadget(id: string): Promise<Result> {
  const m = await me();
  const g = await own(m.userId, id);
  if (!g) return { ok: false, error: "That gadget isn't yours." };
  await supabaseAdmin().from("gadgets").delete().eq("id", g.id).eq("owner_id", m.userId);
  revalidatePath("/gadgets");
  return { ok: true };
}

export async function renameGadget(id: string, title: string): Promise<Result> {
  const m = await me();
  const g = await own(m.userId, id);
  if (!g) return { ok: false, error: "That gadget isn't yours." };
  await supabaseAdmin().from("gadgets").update({ title: cleanTitle(String(title ?? "")) }).eq("id", g.id).eq("owner_id", m.userId);
  revalidatePath(`/gadgets/${g.id}`);
  return { ok: true };
}

/** Which AI the gadget asks (null: the person's usual one). Only the family's models. */
export async function setGadgetModel(id: string, model: string | null): Promise<Result> {
  const m = await me();
  const g = await own(m.userId, id);
  if (!g) return { ok: false, error: "That gadget isn't yours." };
  if (model !== null) {
    const { keys } = await familyKeys(m.profile.family_id);
    if (!askableModels(keys).some((x) => x.id === model)) return { ok: false, error: "Your family can't use that AI." };
  }
  await supabaseAdmin().from("gadgets").update({ model }).eq("id", g.id).eq("owner_id", m.userId);
  revalidatePath(`/gadgets/${g.id}`);
  return { ok: true };
}

/** Goes back to an earlier version (it becomes the newest). */
export async function restoreVersion(id: string, versionId: string): Promise<Result> {
  const m = await me();
  const g = await own(m.userId, id);
  if (!g || typeof versionId !== "string" || !UUID.test(versionId)) return { ok: false, error: "That gadget isn't yours." };
  const { data: v } = await supabaseAdmin()
    .from("gadget_versions")
    .select("html, created_at")
    .eq("id", versionId)
    .eq("gadget_id", g.id)
    .eq("owner_id", m.userId)
    .maybeSingle<{ html: string; created_at: string }>();
  if (!v) return { ok: false, error: "That version has gone." };
  await saveVersion(m.userId, g.id, v.html, "Went back to an earlier version");
  revalidatePath(`/gadgets/${g.id}`);
  return { ok: true };
}

/** What a saved gadget remembers (depeche.save / depeche.load). */
export async function saveGadgetData(id: string, data: string): Promise<Result> {
  const m = await me();
  if (typeof data !== "string" || data.length > MAX_SAVE) return { ok: false, error: "That's too much for a gadget to remember (100 KB at most)." };
  const g = await own(m.userId, id);
  if (!g) return { ok: false, error: "Save the gadget first." };
  await supabaseAdmin()
    .from("gadget_saves")
    .upsert({ gadget_id: g.id, owner_id: m.userId, data, updated_at: new Date().toISOString() }, { onConflict: "gadget_id" });
  return { ok: true };
}

export async function loadGadgetData(id: string): Promise<string | null> {
  const m = await me();
  const g = await own(m.userId, id);
  if (!g) return null;
  const { data } = await supabaseAdmin().from("gadget_saves").select("data").eq("gadget_id", g.id).eq("owner_id", m.userId).maybeSingle<{ data: string }>();
  return data?.data ?? null;
}

/**
 * Shares a copy: with one person in the family (`to` is their id) or on the family shelf
 * (`to` is "family"). Only the page and title go; saves, settings and chats stay with the sender.
 */
export async function shareGadget(id: string, to: string): Promise<Result> {
  const m = await me();
  const g = await own(m.userId, id);
  if (!g) return { ok: false, error: "That gadget isn't yours." };
  if (!(await allow(["adminActions", m.userId]))) return { ok: false, error: "That's a lot at once. Wait a minute and try again." };
  const admin = supabaseAdmin();
  let toId: string | null = null;
  if (to !== "family") {
    if (typeof to !== "string" || !UUID.test(to) || to === m.userId) return { ok: false, error: "Choose someone in your family." };
    const { data: them } = await admin.from("profiles").select("id").eq("id", to).eq("family_id", m.profile.family_id).maybeSingle();
    if (!them) return { ok: false, error: "Choose someone in your family." };
    toId = to;
  }
  const { error } = await admin.from("gadget_shares").insert({ family_id: m.profile.family_id, from_id: m.userId, to_id: toId, title: g.title, html: g.html });
  if (error) return { ok: false, error: "Couldn't share it. Try again." };
  revalidatePath("/gadgets");
  return { ok: true };
}

/** Takes a copy of a shared gadget into My gadgets. */
export async function takeShare(shareId: string): Promise<Result> {
  const m = await me();
  if (typeof shareId !== "string" || !UUID.test(shareId)) return { ok: false, error: "That gadget isn't shared with you." };
  const admin = supabaseAdmin();
  const { data: s } = await admin
    .from("gadget_shares")
    .select("id, family_id, from_id, to_id, title, html")
    .eq("id", shareId)
    .maybeSingle<{ id: string; family_id: string; from_id: string; to_id: string | null; title: string; html: string }>();
  const mine = s && s.family_id === m.profile.family_id && (s.to_id === m.userId || s.to_id === null) && s.from_id !== m.userId;
  if (!s || !mine) return { ok: false, error: "That gadget isn't shared with you." };
  const r = await createGadget(m.userId, s.title, s.html, { sharedBy: s.from_id });
  if ("error" in r) return { ok: false, error: r.error ?? "Couldn't add it." };
  if (s.to_id) await admin.from("gadget_shares").update({ taken: true }).eq("id", s.id);
  revalidatePath("/gadgets");
  return { ok: true, id: r.id };
}

/** Takes a share away: the sender's own, or (for an admin) anything on their family's shelf. */
export async function removeShare(shareId: string): Promise<Result> {
  const m = await me();
  if (typeof shareId !== "string" || !UUID.test(shareId)) return { ok: false, error: "Couldn't remove that." };
  const admin = supabaseAdmin();
  const { data: s } = await admin.from("gadget_shares").select("id, family_id, from_id, to_id").eq("id", shareId).maybeSingle<{ id: string; family_id: string; from_id: string; to_id: string | null }>();
  const may = s && (s.from_id === m.userId || s.to_id === m.userId || (m.profile.role === "admin" && s.family_id === m.profile.family_id && s.to_id === null));
  if (!s || !may) return { ok: false, error: "Couldn't remove that." };
  await admin.from("gadget_shares").delete().eq("id", s.id);
  revalidatePath("/gadgets");
  return { ok: true };
}
