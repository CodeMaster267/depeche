"use server";

import { revalidatePath } from "next/cache";
import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { loadChat, loadShell } from "@/lib/chat/load";
import { UPLOAD_BUCKET } from "@/lib/chat/files";
import type { MessageRow } from "@/lib/chat/thread";

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

/** Stop using one of your chat summaries; the next message reads the original messages again. */
export async function discardSummary(summaryId: string) {
  await requireMe();
  const { error } = await (await supabaseServer()).rpc("discard_chat_summary", { p_id: summaryId });
  if (error) throw new Error("Couldn't change that summary.");
}

/** Turn auto-compaction on or off for one of your chats. */
export async function setCompaction(chatId: string, on: boolean) {
  const me = await requireMe();
  await (await supabaseServer())
    .from("chats")
    .update({ compaction: on ? "auto" : "off" })
    .eq("id", chatId)
    .eq("owner_id", me.userId);
}

export async function rememberModel(modelId: string) {
  const me = await requireMe();
  await (await supabaseServer()).from("profiles").update({ last_model: modelId.slice(0, 100) }).eq("id", me.userId);
}
