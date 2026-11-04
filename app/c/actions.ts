"use server";

import { revalidatePath } from "next/cache";
import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { loadChat, loadShell } from "@/lib/chat/load";
import { UPLOAD_BUCKET } from "@/lib/chat/files";
import type { MessageRow } from "@/lib/chat/thread";
import { snippet, type ChatHit } from "@/lib/chat/find";

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
  const db = await supabaseServer();
  // Its files go straight away too, not at the next clean-up.
  const { data: withFiles } = await db
    .from("messages")
    .select("content")
    .eq("chat_id", chatId)
    .eq("owner_id", me.userId)
    .not("content->files", "is", null)
    .returns<{ content: MessageRow["content"] }[]>();
  const paths = (withFiles ?? []).flatMap((m) => (m.content.files ?? []).map((f) => f.path));
  if (paths.length) await db.storage.from(UPLOAD_BUCKET).remove(paths);
  await db.from("chats").delete().eq("id", chatId).eq("owner_id", me.userId);
  revalidatePath("/", "layout");
}

export async function rememberModel(modelId: string) {
  const me = await requireMe();
  await (await supabaseServer()).from("profiles").update({ last_model: modelId.slice(0, 100) }).eq("id", me.userId);
}

/**
 * Search inside your chats' messages, for the search box above the chat list. It runs as you, so
 * row-level security (and the checks inside search_my_chats) keep it to your own chats: never a
 * family member's, even for an admin. Only a short snippet of each match goes to the browser.
 */
export async function searchChats(query: string): Promise<ChatHit[]> {
  await requireMe();
  const q = String(query ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (q.length < 2) return [];
  const { data, error } = await (await supabaseServer()).rpc("search_my_chats", { p_query: q, p_limit: 20 });
  if (error) {
    console.error("[chat] search_my_chats failed", error);
    throw new Error("Search didn't work");
  }
  return ((data ?? []) as { chat_id: string; message_id: string; role: "user" | "assistant"; text: string }[]).map((h) => ({
    chatId: h.chat_id,
    messageId: h.message_id,
    role: h.role,
    snippet: snippet(h.text ?? "", q),
  }));
}
