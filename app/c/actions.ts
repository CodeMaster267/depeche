"use server";

import { revalidatePath } from "next/cache";
import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { loadChat, loadShell } from "@/lib/chat/load";

/**
 * Chat housekeeping. Everything runs with the person's own session, so row-level security makes
 * sure only their own chats can be read, renamed, pinned or deleted.
 */
export async function refreshShell() {
  return loadShell(await requireMe());
}

export async function refreshChat(chatId: string) {
  return loadChat(await requireMe(), chatId);
}

export async function renameChat(chatId: string, title: string) {
  const me = await requireMe();
  const clean = title.trim().replace(/\s+/g, " ").slice(0, 200);
  if (!clean) return;
  await (await supabaseServer()).from("chats").update({ title: clean }).eq("id", chatId).eq("owner_id", me.userId);
  revalidatePath("/", "layout");
}

export async function pinChat(chatId: string, pinned: boolean) {
  const me = await requireMe();
  await (await supabaseServer()).from("chats").update({ pinned }).eq("id", chatId).eq("owner_id", me.userId);
  revalidatePath("/", "layout");
}

export async function deleteChat(chatId: string) {
  const me = await requireMe();
  await (await supabaseServer()).from("chats").delete().eq("id", chatId).eq("owner_id", me.userId);
  revalidatePath("/", "layout");
}

export async function rememberModel(modelId: string) {
  const me = await requireMe();
  await (await supabaseServer()).from("profiles").update({ last_model: modelId.slice(0, 100) }).eq("id", me.userId);
}
