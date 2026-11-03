import { NextResponse, after, type NextRequest } from "next/server";
import { getMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { decryptSecret, fromBytea } from "@/lib/crypto";
import { estimateCost, findModel, searchCost } from "@/lib/ai/models";
import { ProviderError, streamReply, type Turn } from "@/lib/ai/providers";
import { MAX_MESSAGE_CHARS, activePath, titleFrom, type MessageRow, type Source } from "@/lib/chat/thread";

// Long replies from reasoning models can take minutes. Vercel Hobby allows up to 300 seconds.
export const maxDuration = 300;

type Body = {
  chatId?: string | null;
  clientRequestId?: string;
  text?: string;
  model?: string;
  /** Answer this existing message again instead of sending a new one. */
  regenerate?: string;
  /** Let the model search the web when it needs to. */
  search?: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

/** About 150k tokens of history; older turns beyond that are left out of what the model sees. */
const HISTORY_CHARS = 600_000;

/**
 * Sends a message and streams the reply as newline-separated JSON events:
 *   {type:"start", chatId, userMessageId}  {type:"text", text}  {type:"notice", text}
 *   {type:"searching", query?}  {type:"sources", sources}
 *   {type:"done", message}  or  {type:"error", error, message}
 *
 * The person's own message is written with their session, so row-level security checks it. The
 * reply and its cost are written by the server, since the browser may never write either.
 */
export async function POST(req: NextRequest) {
  const me = await getMe();
  if (!me) return fail(401, "Sign in again to keep chatting.");
  const body = (await req.json().catch(() => ({}))) as Body;

  const model = findModel(body.model);
  if (!model) return fail(400, "Pick a model first.");
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!body.regenerate && !text) return fail(400, "Type a message first.");
  if (text.length > MAX_MESSAGE_CHARS) return fail(400, "That message is too long. Try splitting it up.");
  if (!body.regenerate && !UUID.test(body.clientRequestId ?? "")) return fail(400, "Something went wrong. Try again.");
  if (body.chatId && !UUID.test(body.chatId)) return fail(404, "That chat doesn't exist.");
  if (body.regenerate && !UUID.test(body.regenerate)) return fail(404, "That message doesn't exist.");

  const db = await supabaseServer();
  const admin = supabaseAdmin();

  // The family's key for this model's provider.
  const { data: keyRow } = await admin
    .from("provider_keys")
    .select("ciphertext")
    .eq("family_id", me.profile.family_id)
    .eq("provider", model.provider)
    .maybeSingle<{ ciphertext: string }>();
  if (!keyRow) return fail(400, `Your family hasn't added a key for ${model.name} yet.`);
  let apiKey: string;
  try {
    apiKey = decryptSecret(fromBytea(keyRow.ciphertext));
  } catch {
    return fail(500, "Your family's key needs to be added again. Ask your family admin.");
  }

  // The monthly limit, checked before anything is spent.
  const { data: spent } = await admin.rpc("month_spend", { p_person: me.userId });
  const cap = Number(me.profile.monthly_cap_usd);
  if (Number(spent ?? 0) >= cap) {
    return fail(402, `You've reached your $${cap.toFixed(2)} limit for this month. Your family admin can raise it.`);
  }

  // The chat: an existing one of yours, or a new one titled from the first message.
  let chatId = body.chatId ?? null;
  if (chatId) {
    const { data: chat } = await db.from("chats").select("id").eq("id", chatId).eq("owner_id", me.userId).maybeSingle();
    if (!chat) return fail(404, "That chat doesn't exist.");
  } else {
    if (body.regenerate) return fail(404, "That chat doesn't exist.");
    const { data: chat, error } = await db
      .from("chats")
      .insert({ owner_id: me.userId, title: titleFrom(text), model: model.id })
      .select("id")
      .single<{ id: string }>();
    if (error || !chat) return fail(500, "Couldn't start a chat. Try again.");
    chatId = chat.id;
  }

  const { data: existing } = await db
    .from("messages")
    .select("id, chat_id, parent_id, role, content, status, model, created_at")
    .eq("chat_id", chatId)
    .order("created_at")
    .returns<MessageRow[]>();
  let all = existing ?? [];

  // The question being answered.
  let question: MessageRow;
  if (body.regenerate) {
    const q = all.find((m) => m.id === body.regenerate && m.role === "user");
    if (!q) return fail(404, "That message doesn't exist.");
    question = q;
  } else {
    const parent = activePath(all).at(-1);
    const { data: inserted, error } = await db
      .from("messages")
      .insert({
        chat_id: chatId,
        owner_id: me.userId,
        parent_id: parent?.id ?? null,
        role: "user",
        content: { text },
        client_request_id: body.clientRequestId,
      })
      .select("id, chat_id, parent_id, role, content, status, model, created_at")
      .single<MessageRow>();
    if (error?.code === "23505") {
      // The same send arrived twice (a retry after a dropped connection). Never answer it twice.
      return fail(409, "Already sent.");
    }
    if (error || !inserted) return fail(500, "Couldn't send that. Try again.");
    question = inserted;
    all = [...all, inserted];
  }

  // What the model sees: the conversation up to the question, newest turns kept if it's very long.
  const byId = new Map(all.map((m) => [m.id, m]));
  const path: MessageRow[] = [];
  for (let m: MessageRow | undefined = question; m; m = m.parent_id ? byId.get(m.parent_id) : undefined) path.unshift(m);
  const turns: Turn[] = [];
  let budget = HISTORY_CHARS;
  for (const m of [...path].reverse()) {
    const t = m.content.text ?? "";
    if (!t || m.role === "system" || (m.role === "assistant" && m.status === "failed")) continue;
    if (budget - t.length < 0 && turns.length) break;
    budget -= t.length;
    // Providers expect turns to alternate, so two in a row from one side are joined.
    if (turns[0]?.role === m.role) turns[0] = { ...turns[0], text: `${t}\n\n${turns[0].text}` };
    else turns.unshift({ role: m.role as Turn["role"], text: t });
  }
  while (turns[0]?.role === "assistant") turns.shift();

  const system = [
    `You are a helpful assistant inside Depeche, a private chat app for a family and friends. You're talking with ${me.profile.display_name}.`,
    `Today is ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}.`,
    ...(body.search === true
      ? [
          "You can search the web. Search when the question needs current, local or specific facts you might not know; otherwise answer directly without searching.",
        ]
      : []),
    "Format replies in Markdown. Write maths in LaTeX between $…$ or $$…$$. When a diagram helps, use a ```mermaid code block. Cite sources as Markdown links.",
  ].join(" ");

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());
  const encoder = new TextEncoder();
  const questionId = question.id;
  const finalChatId = chatId;
  // If the person closes the app mid-reply, keep running long enough to save what was written.
  let finished!: () => void;
  after(new Promise<void>((resolve) => (finished = resolve)));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (event: object) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          open = false;
        }
      };
      send({ type: "start", chatId: finalChatId, userMessageId: questionId, userMessage: question });

      let reply = "";
      let used = model;
      let notice: string | undefined;
      let usage: { input: number; output: number } | undefined;
      let sources: Source[] = [];
      let searches = 0;
      let queried = 0;
      let suggestions = "";
      let status: MessageRow["status"] = "completed";
      let error: string | undefined;
      try {
        for await (const ev of streamReply({ model, apiKey, system, turns, signal: abort.signal, search: body.search === true })) {
          if (ev.type === "text") {
            reply += ev.text;
            send(ev);
          } else if (ev.type === "usage") usage = { input: ev.input, output: ev.output };
          else if (ev.type === "model") used = findModel(ev.id) ?? model;
          else if (ev.type === "searching") {
            if (ev.query) queried++;
            send(ev);
          }
          else if (ev.type === "sources") {
            sources = ev.sources.slice(0, 30);
            send({ type: "sources", sources });
          } else if (ev.type === "searches") searches = ev.count;
          else if (ev.type === "suggestions") suggestions = ev.html;
          else {
            // More than one note can apply (a busy model and no search), so they add up.
            notice = notice ? `${notice} ${ev.text}` : ev.text;
            send({ type: "notice", text: notice });
          }
        }
      } catch (e) {
        if (abort.signal.aborted) status = "stopped";
        else {
          status = "failed";
          error = e instanceof ProviderError ? e.message : "Something went wrong while answering. Try again.";
        }
      }

      // Stopped replies have no usage report, so estimate about four characters per token.
      if (!usage) {
        const inputChars = turns.reduce((n, t) => n + t.text.length, system.length);
        usage = { input: status === "failed" ? 0 : Math.ceil(inputChars / 4), output: Math.ceil(reply.length / 4) };
      }
      // A reply stopped mid-search gets no report, so count the searches seen instead (erring high).
      searches = Math.max(searches, queried);
      // Each web search has a fee on top of tokens, so it counts toward the monthly limit too.
      const cost = estimateCost(used, usage.input, usage.output) + searchCost(used.provider, searches);

      const { data: saved } = await admin
        .from("messages")
        .insert({
          chat_id: finalChatId,
          owner_id: me.userId,
          parent_id: questionId,
          role: "assistant",
          content: {
            text: reply,
            ...(notice ? { notice } : {}),
            ...(error ? { error } : {}),
            ...(sources.length ? { sources } : {}),
            ...(searches ? { searches } : {}),
            ...(suggestions ? { suggestions } : {}),
            cost,
          },
          status,
          provider: used.provider,
          model: used.id,
        })
        .select("id, chat_id, parent_id, role, content, status, model, created_at")
        .single<MessageRow>();
      const now = new Date().toISOString();
      await Promise.all([
        usage.input || usage.output || cost
          ? admin.from("usage_events").insert({
              owner_id: me.userId,
              message_id: saved?.id ?? null,
              provider: used.provider,
              model: used.id,
              input_tokens: usage.input,
              output_tokens: usage.output,
              cost_usd: cost.toFixed(6),
            })
          : null,
        admin.from("chats").update({ updated_at: now, model: model.id }).eq("id", finalChatId),
        admin.from("profiles").update({ last_model: model.id }).eq("id", me.userId),
      ]);

      if (error) send({ type: "error", error, message: saved });
      else send({ type: "done", message: saved });
      try {
        if (open) controller.close();
      } catch {
        // The browser already went away.
      }
      finished();
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
