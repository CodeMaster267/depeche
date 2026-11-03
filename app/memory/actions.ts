"use server";

import { revalidatePath } from "next/cache";
import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { MAX_MEMORY_CHARS } from "@/lib/chat/memory";

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
