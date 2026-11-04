"use server";

import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { loadChat, loadShell } from "@/lib/chat/load";
import { UPLOAD_BUCKET } from "@/lib/chat/files";
import type { ChatRow, MessageRow } from "@/lib/chat/thread";

/**
 * Chat housekeeping. Everything runs with the person's own session, so row-level security makes
 * sure only their own chats can be read, renamed, pinned,
 * archived or deleted. The chat screen shows each change straight away, so these don't refresh the
 * page (that made each tap re-render the whole screen on the server); other pages load fresh anyway.
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
}

export async function pinChat(chatId: string, pinned: boolean) {
  const me = await requireMe();
  await (await supabaseServer()).from("chats").update({ pinned }).eq("id", chatId).eq("owner_id", me.userId);
}

/** Archive (out of the list, kept) or restore one of your chats. */
export async function archiveChat(chatId: string, archived: boolean) {
  const me = await requireMe();
  await (await supabaseServer())
    .from("chats")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", chatId)
    .eq("owner_id", me.userId);
}

/** Your archived chats, most recently archived first. */
export async function listArchived(): Promise<ChatRow[]> {
  const me = await requireMe();
  const { data } = await (await supabaseServer())
    .from("chats")
    .select("id, title, model, pinned, updated_at, archived_at")
    .eq("owner_id", me.userId)
    .not("archived_at", "is", null)
    .order("archived_at", { ascending: false })
    .limit(500)
    .returns<ChatRow[]>();
  return data ?? [];
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
}

export async function rememberModel(modelId: string) {
  const me = await requireMe();
  await (await supabaseServer()).from("profiles").update({ last_model: modelId.slice(0, 100) }).eq("id", me.userId);
}
