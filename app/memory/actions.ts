"use server";

import { revalidatePath } from "next/cache";
import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { MAX_MEMORY_CHARS } from "@/lib/chat/memory";
import { MAX_INSTRUCTION_CHARS, cleanInstruction } from "@/lib/chat/instructions";

/**
 * Memories are yours alone: every change runs with your own session, so row-level security keeps
 * them away from everyone else, family admins and the app owner included.
 */
export async function decideMemory(id: string, keep: boolean): Promise<void> {
  const me = await requireMe();
  await (await supabaseServer())
    .from("memories")
    .update({ status: keep ? "active" : "rejected", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("owner_id", me.userId)
    .eq("status", "suggested");
  // No revalidation: the memory page is always read fresh, and refreshing would redraw the chat.
}

export type MemoryState = { error?: string; ok?: string } | undefined;

export async function addMemory(_: MemoryState, form: FormData): Promise<MemoryState> {
  const me = await requireMe();
  const content = String(form.get("content") ?? "").replace(/\s+/g, " ").trim();
  if (!content) return { error: "Write something to remember." };
  if (content.length > MAX_MEMORY_CHARS) return { error: `Keep it under ${MAX_MEMORY_CHARS} characters.` };
  const { error } = await (await supabaseServer()).from("memories").insert({ owner_id: me.userId, content, status: "active" });
  if (error) return { error: "Couldn't save that. Try again." };
  revalidatePath("/memory");
  return { ok: "Remembered." };
}

export async function forgetMemory(id: string): Promise<void> {
  const me = await requireMe();
  await (await supabaseServer()).from("memories").delete().eq("id", id).eq("owner_id", me.userId);
  revalidatePath("/memory");
}

export async function forgetAll(): Promise<void> {
  const me = await requireMe();
  await (await supabaseServer()).from("memories").delete().eq("owner_id", me.userId);
  revalidatePath("/memory");
}

export type InstructionsState = { error?: string; ok?: string } | undefined;

/** Your personal instructions, saved as you, so nobody else (admins included) can read them. */
export async function saveInstructions(_: InstructionsState, form: FormData): Promise<InstructionsState> {
  const me = await requireMe();
  const about = cleanInstruction(String(form.get("about_me") ?? ""));
  const style = cleanInstruction(String(form.get("answer_style") ?? ""));
  if (about.length > MAX_INSTRUCTION_CHARS || style.length > MAX_INSTRUCTION_CHARS) {
    return { error: `Keep each one under ${MAX_INSTRUCTION_CHARS.toLocaleString("en-GB")} characters.` };
  }
  const db = await supabaseServer();
  const fields = { about_me: about, answer_style: style, enabled: form.get("enabled") === "on", updated_at: new Date().toISOString() };
  // Update first; only the very first save inserts. (An upsert would also try to update owner_id,
  // which nobody may change.)
  const updated = await db.from("personal_instructions").update(fields).eq("owner_id", me.userId).select("owner_id");
  let error = updated.error;
  if (!error && !updated.data?.length) {
    ({ error } = await db.from("personal_instructions").insert({ owner_id: me.userId, ...fields }));
  }
  if (error) return { error: "Couldn't save that. Try again." };
  revalidatePath("/memory");
  return { ok: "Saved. Depeche uses these in every chat from now on." };
}
