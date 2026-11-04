"use server";

import { requireMe, siteOrigin } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { MAX_SHARE_CHARS, shareToken, snapshot, snapshotChars } from "@/lib/chat/share";
import type { MessageRow } from "@/lib/chat/thread";

export type ShareState = { url: string; updatedAt: string } | null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** This chat's share link, if it has one. Read with your own session: only your shares are visible. */
export async function getShare(chatId: string): Promise<ShareState> {
  await requireMe();
  if (!UUID.test(chatId)) return null;
  const { data } = await (await supabaseServer())
    .from("chat_shares")
    .select("token, updated_at")
    .eq("chat_id", chatId)
    .maybeSingle<{ token: string; updated_at: string }>();
  return data ? { url: `${await siteOrigin()}/s/${data.token}`, updatedAt: data.updated_at } : null;
}

/**
 * Share a chat, or update its share to the conversation as it is now (the link stays the same).
 * The messages are read with your own session, so only a chat of yours can be copied; the copy is
 * then written by the server, since the browser may never write a share itself.
 */
export async function shareChat(chatId: string): Promise<{ share?: ShareState; error?: string }> {
  const me = await requireMe();
  if (!UUID.test(chatId)) return { error: "That chat doesn't exist." };
  const db = await supabaseServer();
  const { data: chat } = await db
    .from("chats")
    .select("id, title")
    .eq("id", chatId)
    .eq("owner_id", me.userId)
    .maybeSingle<{ id: string; title: string }>();
  if (!chat) return { error: "That chat doesn't exist." };
  const { data: rows } = await db
    .from("messages")
    .select("id, chat_id, parent_id, role, content, status, model, created_at")
    .eq("chat_id", chatId)
    .eq("owner_id", me.userId)
    .order("created_at")
    .returns<MessageRow[]>();
  const messages = snapshot(rows ?? []);
  if (!messages.length) return { error: "There's nothing in this chat to share yet." };
  if (snapshotChars(messages) > MAX_SHARE_CHARS) return { error: "This chat is too long to share." };

  const admin = supabaseAdmin();
  const now = new Date().toISOString();
  const { data: existing } = await admin
    .from("chat_shares")
    .select("id")
    .eq("chat_id", chatId)
    .eq("owner_id", me.userId)
    .maybeSingle<{ id: string }>();
  const { data: saved, error } = existing
    ? await admin
        .from("chat_shares")
        .update({ title: chat.title, messages, updated_at: now })
        .eq("id", existing.id)
        .select("token, updated_at")
        .single<{ token: string; updated_at: string }>()
    : await admin
        .from("chat_shares")
        .insert({ token: shareToken(), chat_id: chatId, owner_id: me.userId, title: chat.title, messages })
        .select("token, updated_at")
        .single<{ token: string; updated_at: string }>();
  if (error || !saved) return { error: "Couldn't share this chat. Try again." };
  return { share: { url: `${await siteOrigin()}/s/${saved.token}`, updatedAt: saved.updated_at } };
}

/** Stop sharing: the link stops working straight away. */
export async function stopSharing(chatId: string): Promise<void> {
  const me = await requireMe();
  if (!UUID.test(chatId)) return;
  const { error } = await (await supabaseServer()).from("chat_shares").delete().eq("chat_id", chatId).eq("owner_id", me.userId);
  if (error) throw new Error("Couldn't stop sharing");
}
