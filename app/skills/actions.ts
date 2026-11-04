"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { friendly, requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export type SkillActionState = { error?: string; ok?: string } | undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Adds a library skill to your own list. Your session, so row-level security checks it. */
export async function addToMine(id: string): Promise<SkillActionState> {
  const me = await requireMe();
  if (!UUID.test(id)) return { error: "That skill doesn't exist." };
  const { error } = await (await supabaseServer()).from("skill_picks").insert({ owner_id: me.userId, skill_id: id });
  if (error && error.code !== "23505") return { error: friendly(error, "Couldn't add that skill. Try again.") };
  revalidatePath("/skills");
  revalidatePath(`/skills/${id}`);
  return { ok: "Added. Your chats will use it when it fits." };
}

export async function removeFromMine(id: string): Promise<SkillActionState> {
  const me = await requireMe();
  if (!UUID.test(id)) return { error: "That skill doesn't exist." };
  await (await supabaseServer()).from("skill_picks").delete().eq("owner_id", me.userId).eq("skill_id", id);
  revalidatePath("/skills");
  revalidatePath(`/skills/${id}`);
  return { ok: "Removed from your skills." };
}

/** Deletes a skill you made, for everyone who added it. Your session: only your own can go. */
export async function deleteSkill(id: string): Promise<void> {
  const me = await requireMe();
  if (!UUID.test(id)) return;
  await (await supabaseServer()).from("skills").delete().eq("id", id).eq("owner_id", me.userId);
  revalidatePath("/skills");
  redirect("/skills");
}

/**
 * Takes a skill out of the library. The database decides who may: the app owner (any skill), or
 * an admin of the family that made it.
 */
export async function removeFromLibrary(id: string, _: SkillActionState, form: FormData): Promise<SkillActionState> {
  const me = await requireMe();
  if (!UUID.test(id)) return { error: "That skill doesn't exist." };
  const note = String(form.get("note") ?? "").slice(0, 300);
  const { error } = await supabaseAdmin().rpc("remove_skill", { p_actor: me.userId, p_skill: id, p_note: note });
  if (error) return { error: friendly(error, "Couldn't remove that skill. Try again.") };
  revalidatePath("/skills");
  revalidatePath(`/skills/${id}`);
  return { ok: "Removed from the library. Nobody's chats will use it now." };
}
