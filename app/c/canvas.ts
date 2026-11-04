"use server";

import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { loadCanvases } from "@/lib/chat/canvas";
import { MAX_CANVAS_CHARS, type Canvas, type CanvasVersion } from "@/lib/canvas";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A chat's canvases. Runs with the person's own session: row-level security keeps it to their own. */
export async function listCanvases(chatId: string): Promise<Canvas[]> {
  const me = await requireMe();
  if (!UUID.test(chatId)) return [];
  return loadCanvases(await supabaseServer(), me.userId, chatId);
}

/**
 * Saves the person's edit as a new version (versions are never changed or removed). Row-level
 * security only lets a person add their own versions to their own canvases.
 */
export async function saveCanvas(canvasId: string, content: string): Promise<{ version?: CanvasVersion; error?: string }> {
  const me = await requireMe();
  if (!UUID.test(canvasId)) return { error: "That canvas doesn't exist." };
  if (typeof content !== "string" || content.length > MAX_CANVAS_CHARS) return { error: "That's too long for a canvas." };
  const { data, error } = await (await supabaseServer())
    .from("canvas_versions")
    .insert({ canvas_id: canvasId, owner_id: me.userId, content, author: "person" })
    .select("id, content, author, message_id, created_at")
    .single<CanvasVersion>();
  if (error || !data) return { error: "Couldn't save your changes. Try again." };
  return { version: data };
}
