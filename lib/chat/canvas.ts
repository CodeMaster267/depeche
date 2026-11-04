import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canvasBlocks, type Canvas, type CanvasVersion } from "@/lib/canvas";

/** Versions kept on screen per canvas, newest last. Older ones stay in the database and the export. */
const VERSIONS_SHOWN = 50;

/**
 * A chat's canvases with their recent versions. Read with the person's own session, so row-level
 * security keeps it to their own; the owner check is repeated so an admin's client can't widen it.
 */
export async function loadCanvases(db: SupabaseClient, ownerId: string, chatId: string): Promise<Canvas[]> {
  const { data: canvases } = await db
    .from("canvases")
    .select("id, title, updated_at")
    .eq("chat_id", chatId)
    .eq("owner_id", ownerId)
    .order("updated_at", { ascending: false })
    .returns<Omit<Canvas, "versions">[]>();
  if (!canvases?.length) return [];
  const lists = await Promise.all(
    canvases.map((c) =>
      db
        .from("canvas_versions")
        .select("id, content, author, message_id, created_at")
        .eq("canvas_id", c.id)
        .eq("owner_id", ownerId)
        .order("created_at", { ascending: false })
        .limit(VERSIONS_SHOWN)
        .returns<CanvasVersion[]>(),
    ),
  );
  return canvases.map((c, i) => ({ ...c, versions: (lists[i].data ?? []).reverse() }));
}

/**
 * Saves the canvases a reply wrote, as the AI's versions. Runs as the server (service role), after
 * the reply itself is saved, so the browser can never claim to be the AI. A block with the title
 * of a canvas already in this chat is a new version of it; any other title starts a new canvas.
 */
export async function saveReplyCanvases(admin: SupabaseClient, ownerId: string, chatId: string, messageId: string, reply: string) {
  const blocks = canvasBlocks(reply).filter((b) => b.closed);
  if (!blocks.length) return;
  const { data: existing } = await admin
    .from("canvases")
    .select("id, title")
    .eq("chat_id", chatId)
    .eq("owner_id", ownerId)
    .returns<{ id: string; title: string }[]>();
  const byTitle = new Map((existing ?? []).map((c) => [c.title.toLowerCase(), c.id]));
  for (const block of blocks) {
    let id = byTitle.get(block.title.toLowerCase());
    if (!id) {
      const { data: made } = await admin
        .from("canvases")
        .insert({ chat_id: chatId, owner_id: ownerId, title: block.title })
        .select("id")
        .single<{ id: string }>();
      if (!made) continue;
      id = made.id;
      byTitle.set(block.title.toLowerCase(), id);
    }
    await admin.from("canvas_versions").insert({ canvas_id: id, owner_id: ownerId, content: block.content, author: "assistant", message_id: messageId });
  }
}
