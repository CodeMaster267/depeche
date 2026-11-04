import { NextResponse, type NextRequest } from "next/server";
import { getMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { findModel } from "@/lib/ai/models";
import { allow } from "@/lib/rate-limit";
import { activePath, type MessageRow } from "@/lib/chat/thread";
import { compactChat, compactOverride, loadSummaries } from "@/lib/chat/compact";

// Summarising a long chat can take a while; it gets its own five minutes on Vercel Hobby.
export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

/**
 * Summarises the older part of one of your chats so the next messages cost less. The app calls it
 * in the background after a reply says the chat is due, and from "Redo summary" with `redo` (the
 * summary to replace). Answers {summary} or {skipped: reason}.
 */
export async function POST(req: NextRequest) {
  const me = await getMe();
  if (!me) return fail(401, "Sign in again.");
  const body = (await req.json().catch(() => ({}))) as { chatId?: string; redo?: string };
  if (!UUID.test(body.chatId ?? "") || (body.redo && !UUID.test(body.redo))) return fail(404, "That chat doesn't exist.");
  if (!(await allow(["summariesPerHour", me.userId]))) return fail(429, "Too many summaries for now. Try again later.");

  const db = await supabaseServer();
  const { data: chat } = await db
    .from("chats")
    .select("id, model, compaction")
    .eq("id", body.chatId!)
    .eq("owner_id", me.userId)
    .maybeSingle<{ id: string; model: string | null; compaction: string }>();
  if (!chat) return fail(404, "That chat doesn't exist.");
  if (chat.compaction === "off") return NextResponse.json({ skipped: "summaries are off for this chat" });
  const model = findModel(chat.model);
  if (!model) return NextResponse.json({ skipped: "no model" });

  const { data: messages } = await db
    .from("messages")
    .select("id, chat_id, parent_id, role, content, status, model, created_at")
    .eq("chat_id", chat.id)
    .order("created_at")
    .returns<MessageRow[]>();
  const path = activePath(messages ?? []);
  let summaries = await loadSummaries(db, chat.id);

  let throughIndex: number | undefined;
  if (body.redo) {
    const old = summaries.find((s) => s.id === body.redo);
    const at = old ? path.findIndex((m) => m.id === old.through_message_id) : -1;
    if (!old || at < 0) return fail(404, "That summary doesn't exist.");
    const { error } = await db.rpc("discard_chat_summary", { p_id: old.id });
    if (error) return fail(500, "Couldn't redo the summary. Try again.");
    summaries = summaries.filter((s) => s.id !== old.id);
    throughIndex = at;
  }

  const result = await compactChat({
    userId: me.userId,
    name: me.profile.display_name,
    familyId: me.profile.family_id,
    chatId: chat.id,
    chatModel: model,
    path,
    summaries,
    // Finish even if the app closes meanwhile: the summary is still useful next time.
    signal: AbortSignal.timeout(280_000),
    throughIndex,
    override: compactOverride(),
  }).catch(() => ({ skipped: "the summary failed" }));
  return NextResponse.json(result);
}
