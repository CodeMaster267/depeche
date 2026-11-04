import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { MAX_WIDGET } from "@/lib/widgets/frame";

/** Saved gadgets and their versions. Only the server writes them; people read their own (RLS). */

/** Versions kept per gadget; older ones are let go. */
export const KEEP_VERSIONS = 20;
/** Gadgets one person can keep. */
export const MAX_GADGETS = 100;
export const MAX_SAVE = 100_000;

export const cleanTitle = (t: string) =>
  t.replace(/[-_]+/g, " ").replace(/[\u0000-\u001F\u007F‎‏‪-‮⁦-⁩<>]/g, "").trim().slice(0, 60) || "Gadget";

export async function createGadget(ownerId: string, title: string, html: string, opts: { chatId?: string | null; sharedBy?: string | null } = {}) {
  const admin = supabaseAdmin();
  const { count } = await admin.from("gadgets").select("id", { count: "exact", head: true }).eq("owner_id", ownerId);
  if ((count ?? 0) >= MAX_GADGETS) return { error: `You can keep up to ${MAX_GADGETS} gadgets. Delete one first.` } as const;
  const { data, error } = await admin
    .from("gadgets")
    .insert({ owner_id: ownerId, title: cleanTitle(title), html: html.slice(0, MAX_WIDGET), chat_id: opts.chatId ?? null, shared_by: opts.sharedBy ?? null })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) return { error: "Couldn't save the gadget. Try again." } as const;
  await admin.from("gadget_versions").insert({ gadget_id: data.id, owner_id: ownerId, html: html.slice(0, MAX_WIDGET), note: opts.sharedBy ? "Shared with you" : "First version" });
  return { id: data.id } as const;
}

/** A new version becomes the gadget's page; the oldest beyond KEEP_VERSIONS are let go. */
export async function saveVersion(ownerId: string, gadgetId: string, html: string, note: string) {
  const admin = supabaseAdmin();
  await admin.from("gadgets").update({ html, updated_at: new Date().toISOString() }).eq("id", gadgetId).eq("owner_id", ownerId);
  await admin.from("gadget_versions").insert({ gadget_id: gadgetId, owner_id: ownerId, html, note: note.slice(0, 300) });
  const { data: old } = await admin
    .from("gadget_versions")
    .select("id")
    .eq("gadget_id", gadgetId)
    .order("created_at", { ascending: false })
    .range(KEEP_VERSIONS, 500);
  if (old?.length) await admin.from("gadget_versions").delete().in("id", old.map((v) => v.id));
}
