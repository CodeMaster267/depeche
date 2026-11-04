"use server";

import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { PROMPT_BODY_MAX, promptTitle, type SavedPrompt } from "@/lib/chat/prompts";

/**
 * Saved prompts. Everything runs with the person's own session, so row-level security keeps each
 * person's prompts to themselves.
 */
export async function listPrompts(): Promise<SavedPrompt[]> {
  const me = await requireMe();
  const { data } = await (await supabaseServer())
    .from("saved_prompts")
    .select("id, title, body, updated_at")
    .eq("owner_id", me.userId)
    .order("updated_at", { ascending: false })
    .returns<SavedPrompt[]>();
  return data ?? [];
}

export async function savePrompt(input: { id?: string; title: string; body: string }): Promise<{ prompt?: SavedPrompt; error?: string }> {
  const me = await requireMe();
  const body = String(input.body ?? "").trim().slice(0, PROMPT_BODY_MAX);
  if (!body) return { error: "Write the prompt first." };
  const title = promptTitle(String(input.title ?? ""), body);
  const db = await supabaseServer();
  const query = input.id
    ? db.from("saved_prompts").update({ title, body, updated_at: new Date().toISOString() }).eq("id", input.id).eq("owner_id", me.userId)
    : db.from("saved_prompts").insert({ owner_id: me.userId, title, body });
  const { data, error } = await query.select("id, title, body, updated_at").single<SavedPrompt>();
  if (error || !data) return { error: error?.code === "P0001" ? `${error.message}.` : "Couldn't save that prompt. Try again." };
  return { prompt: data };
}

export async function deletePrompt(id: string): Promise<void> {
  const me = await requireMe();
  await (await supabaseServer()).from("saved_prompts").delete().eq("id", id).eq("owner_id", me.userId);
}
