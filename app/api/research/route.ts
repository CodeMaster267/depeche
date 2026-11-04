import { NextResponse, after, type NextRequest } from "next/server";
import { getMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { canSearch, findModel } from "@/lib/ai/models";
import { allow } from "@/lib/rate-limit";
import { MAX_MESSAGE_CHARS, activePath, titleFrom, type MessageRow } from "@/lib/chat/thread";
import { CONTEXT_CHARS } from "@/lib/research/prompts";
import { RUN_COLUMNS, advance } from "@/lib/research/run";

// The first step runs after the reply below, within this request's own time limit.
export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

/**
 * Starts deep research on a question: saves the question as the person's message, opens a research
 * run, and starts its first step in the background. The browser follows progress by reading the run
 * (its own row, through row-level security); the report arrives as an ordinary reply.
 */
export async function POST(req: NextRequest) {
  const me = await getMe();
  if (!me) return fail(401, "Sign in again to keep chatting.");
  if (me.profile.must_change_password) return fail(403, "Choose a new password first, in Account.");
  const body = (await req.json().catch(() => ({}))) as { chatId?: string | null; clientRequestId?: string; text?: string; model?: string };

  const model = findModel(body.model);
  if (!model) return fail(400, "Pick a model first.");
  if (!canSearch(model)) return fail(400, `${model.name} can't search the web. Pick another model for deep research.`);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return fail(400, "Type what you'd like researched first.");
  if (text.length > MAX_MESSAGE_CHARS) return fail(400, "That message is too long. Try splitting it up.");
  if (!UUID.test(body.clientRequestId ?? "")) return fail(400, "Something went wrong. Try again.");
  if (body.chatId && !UUID.test(body.chatId)) return fail(404, "That chat doesn't exist.");
  if (!(await allow(["messagesPerMinute", me.userId], ["researchPerDay", me.userId]))) {
    return fail(429, "That's a lot of research for one day. Try again tomorrow.");
  }

  const db = await supabaseServer();
  const admin = supabaseAdmin();
  const { data: keyRow } = await admin
    .from("provider_keys")
    .select("provider")
    .eq("family_id", me.profile.family_id)
    .eq("provider", model.provider)
    .maybeSingle();
  if (!keyRow) return fail(400, `Your family hasn't added a key for ${model.name} yet.`);

  let chatId = body.chatId ?? null;
  let all: MessageRow[] = [];
  if (chatId) {
    const { data: chat } = await db.from("chats").select("id").eq("id", chatId).eq("owner_id", me.userId).maybeSingle();
    if (!chat) return fail(404, "That chat doesn't exist.");
    const { data: running } = await db.from("research_runs").select("id").eq("chat_id", chatId).eq("status", "running").limit(1);
    if (running?.length) return fail(409, "This chat is already researching something. Wait for it, or stop it first.");
    const { data: existing } = await db
      .from("messages")
      .select("id, chat_id, parent_id, role, content, status, model, created_at")
      .eq("chat_id", chatId)
      .order("created_at")
      .returns<MessageRow[]>();
    all = existing ?? [];
  } else {
    const { data: chat, error } = await db
      .from("chats")
      .insert({ owner_id: me.userId, title: titleFrom(text), model: model.id })
      .select("id")
      .single<{ id: string }>();
    if (error || !chat) return fail(500, "Couldn't start a chat. Try again.");
    chatId = chat.id;
  }

  const path = activePath(all);
  const { data: question, error } = await db
    .from("messages")
    .insert({
      chat_id: chatId,
      owner_id: me.userId,
      parent_id: path.at(-1)?.id ?? null,
      role: "user",
      content: { text },
      client_request_id: body.clientRequestId,
    })
    .select("id, chat_id, parent_id, role, content, status, model, created_at")
    .single<MessageRow>();
  if (error?.code === "23505") return fail(409, "Already sent.");
  if (error || !question) return fail(500, "Couldn't send that. Try again.");

  // The last few messages, newest kept, so "research that further" makes sense.
  let context = "";
  for (const m of [...path].reverse()) {
    if (m.role === "system" || m.status === "failed" || !m.content.text) continue;
    const line = `${m.role === "user" ? "Person" : "Assistant"}: ${m.content.text.slice(0, 3_000)}`;
    if (context.length + line.length > CONTEXT_CHARS) break;
    context = context ? `${line}\n\n${context}` : line;
  }

  const { data: run, error: runError } = await admin
    .from("research_runs")
    .insert({ owner_id: me.userId, chat_id: chatId, question_id: question.id, model: model.id, context })
    .select(RUN_COLUMNS)
    .single();
  if (runError || !run) return fail(500, "Couldn't start the research. Try again.");
  await Promise.all([
    admin.from("chats").update({ updated_at: new Date().toISOString(), model: model.id }).eq("id", chatId),
    admin.from("profiles").update({ last_model: model.id }).eq("id", me.userId),
  ]);

  const origin = req.nextUrl.origin;
  after(() => advance((run as { id: string }).id, origin));
  return NextResponse.json({ chatId, userMessage: question, run });
}
