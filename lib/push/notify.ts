import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { pushTo } from "./server";

/**
 * Called once an answer is saved. If the person left the app while it was being written (the app
 * marked this request as "away"), their devices get a notification that opens the chat. Someone
 * still watching the answer arrive gets nothing.
 *
 * The notification names the chat but never quotes the answer, since it can show on a lock screen.
 */
export async function notifyIfAway(ownerId: string, requestId: string, chatId: string, ok: boolean): Promise<boolean> {
  const admin = supabaseAdmin();
  const { data: away } = await admin
    .from("push_away")
    .delete()
    .eq("owner_id", ownerId)
    .eq("request_id", requestId)
    .select("request_id");
  if (!away?.length) return false;
  const { data: chat } = await admin.from("chats").select("title").eq("id", chatId).maybeSingle<{ title: string | null }>();
  const title = chat?.title?.trim() || "Depeche";
  await pushTo(ownerId, {
    title,
    body: ok ? "Your answer is ready." : "The answer didn't finish. Open the chat to try again.",
    url: `/c/${chatId}`,
    tag: `chat-${chatId}`,
  });
  return true;
}
