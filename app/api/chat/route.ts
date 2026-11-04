import { NextResponse, after, type NextRequest } from "next/server";
import { getMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { decryptSecret, fromBytea } from "@/lib/crypto";
import { MAX_SEARCHES, canLookUp, canThinkHarder, estimateCost, findModel, searchCost } from "@/lib/ai/models";
import { ProviderError, fakeAi, modelsThatMayAnswer, streamReply, type Turn, type TurnFile } from "@/lib/ai/providers";
import { CHAT_SEARCH_RESULT_TOKENS, MAX_CHAT_SEARCHES, chatSearcher, shouldOfferChatSearch } from "@/lib/chat/search";
import { MEMORY_PROMPT_LIMIT, memoryFilter, memoryInstructions } from "@/lib/chat/memory";
import { MAX_FILES_PER_MESSAGE, OFFICE_TYPES, UPLOAD_BUCKET, isFileRef, readAsText, type FileRef } from "@/lib/chat/files";
import { documentText } from "@/lib/docs/read";
import { inputTokensUpperBound, planReply } from "@/lib/ai/budget";
import { allow } from "@/lib/rate-limit";
import { MAX_QUERIES, MAX_REASONING_CHARS, thinkingClock } from "@/lib/chat/activity";
import { MAX_MESSAGE_CHARS, activePath, titleFrom, type MessageRow, type Source } from "@/lib/chat/thread";

// Long replies from reasoning models can take minutes. Vercel Hobby allows up to 300 seconds.
export const maxDuration = 300;

type Body = {
  chatId?: string | null;
  clientRequestId?: string;
  text?: string;
  /** Files already uploaded to the person's own folder. */
  files?: unknown[];
  model?: string;
  /** Answer this existing message again instead of sending a new one. */
  regenerate?: string;
  /**
   * The message this one follows: the end of the conversation as shown, or, for an edit, the
   * message before the one being edited (null when editing the first). Left out, the newest.
   */
  parent?: string | null;
  /** Let the model search the web when it needs to. */
  search?: boolean;
  /** Sent from voice chat: the reply will be read aloud. */
  voice?: boolean;
  /** "Think harder": the model's highest usual reasoning effort, where it takes one. */
  harder?: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

/** About 150k tokens of history; older turns beyond that are left out of what the model sees. */
const HISTORY_CHARS = 600_000;
/** Images and PDFs sent with one request, newest first; older ones are named but not re-sent. */
const FILE_BYTES_BUDGET = 30 * 1024 * 1024;

/**
 * Sends a message and streams the reply as newline-separated JSON events:
 *   {type:"start", chatId, userMessageId}  {type:"text", text}  {type:"notice", text}
 *   {type:"thinking", text}  {type:"searching", query?}  {type:"sources", sources}
 *   {type:"done", message}  or  {type:"error", error, message}
 *
 * The person's own message is written with their session, so row-level security checks it. The
 * reply and its cost are written by the server, since the browser may never write either.
 */
export async function POST(req: NextRequest) {
  const me = await getMe();
  if (!me) return fail(401, "Sign in again to keep chatting.");
  if (me.profile.must_change_password) return fail(403, "Choose a new password first, in Account.");
  if (!(await allow(["messagesPerMinute", me.userId], ["messagesPerDay", me.userId]))) {
    return fail(429, "You're sending messages very fast. Wait a minute and try again.");
  }
  const body = (await req.json().catch(() => ({}))) as Body;

  const model = findModel(body.model);
  if (!model) return fail(400, "Pick a model first.");
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length > MAX_FILES_PER_MESSAGE) return fail(400, `Attach up to ${MAX_FILES_PER_MESSAGE} files at a time.`);
  if (!files.every((f) => isFileRef(f, me.userId))) return fail(400, "One of those files can't be sent. Attach it again.");
  const fileRefs = files as FileRef[];
  if (!body.regenerate && !text && !fileRefs.length) return fail(400, "Type a message first.");
  if (text.length > MAX_MESSAGE_CHARS) return fail(400, "That message is too long. Try splitting it up.");
  if (!body.regenerate && !UUID.test(body.clientRequestId ?? "")) return fail(400, "Something went wrong. Try again.");
  if (body.chatId && !UUID.test(body.chatId)) return fail(404, "That chat doesn't exist.");
  if (body.regenerate && !UUID.test(body.regenerate)) return fail(404, "That message doesn't exist.");
  const parentGiven = "parent" in body && !body.regenerate;
  if (parentGiven && body.parent !== null && !UUID.test(String(body.parent))) return fail(404, "That message doesn't exist.");

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

  // The chat: an existing one of yours, or (once the spending hold is in place) a new one.
  let chatId = body.chatId ?? null;
  let all: MessageRow[] = [];
  if (chatId) {
    const { data: chat } = await db.from("chats").select("id").eq("id", chatId).eq("owner_id", me.userId).maybeSingle();
    if (!chat) return fail(404, "That chat doesn't exist.");
    const { data: existing } = await db
      .from("messages")
      .select("id, chat_id, parent_id, role, content, status, model, created_at")
      .eq("chat_id", chatId)
      .order("created_at")
      .returns<MessageRow[]>();
    all = existing ?? [];
  } else if (body.regenerate || (parentGiven && body.parent)) {
    return fail(404, "That chat doesn't exist.");
  }
  // An edit or a reply to an earlier version must follow a message in this same chat.
  if (parentGiven && body.parent && !all.some((m) => m.id === body.parent)) return fail(404, "That message doesn't exist.");

  // The monthly limit is a hard one: reserve the most this reply could cost before anything is
  // spent, counting other replies still being written. The reply is then kept short enough to fit.
  const search = body.search === true;
  // Thinking harder costs more output, which stays within the same spending hold.
  const harder = body.harder === true && canThinkHarder(model);
  // What the person asked Depeche to remember. Their own rows only, read as them.
  const { data: remembered } = await db
    .from("memories")
    .select("content")
    .eq("owner_id", me.userId)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(MEMORY_PROMPT_LIMIT)
    .returns<{ content: string }[]>();
  const system = systemPrompt(
    me.profile.display_name,
    Boolean(body.voice),
    (remembered ?? []).map((m) => m.content),
  );
  let historyChars = 0;
  const seen = [system, text];
  for (const m of [...all].reverse()) {
    const t = m.content.text ?? "";
    if (historyChars + t.length > HISTORY_CHARS + 50_000) break;
    historyChars += t.length;
    seen.push(t);
  }
  // Attached files count too: text files as text, images and PDFs by size, erring high.
  let fileTokens = 0;
  let binaryBytes = 0;
  for (const f of [...fileRefs, ...all.flatMap((m) => (m.role === "user" ? (m.content.files ?? []) : []))]) {
    if (!isFileRef(f, me.userId)) continue;
    if (f.mime === "text/plain") fileTokens += Math.ceil(Math.min(f.size, 200_000) / 2);
    // Word, Excel and PowerPoint files are zipped, so their text can be several times their size.
    else if (OFFICE_TYPES.includes(f.mime)) fileTokens += Math.ceil(Math.min(f.size * 5, 200_000) / 2);
    else if (binaryBytes + f.size <= FILE_BYTES_BUDGET) {
      binaryBytes += f.size;
      fileTokens += f.mime === "application/pdf" ? Math.ceil(f.size / 40) + 3_000 : 5_000;
    }
  }
  // "Search this chat" may be offered when part of the chat won't be sent word for word (very
  // long chats today; summarised ones once compaction lands). Each lookup sends the conversation
  // to the model again, so the hold covers that too, or the tool isn't offered.
  const historyTotal = all.reduce((n, m) => n + (m.content.text?.length ?? 0), text.length);
  let mayLookUp = canLookUp(model.provider) && (historyTotal + fileTokens * 2 > HISTORY_CHARS * 0.8 || fakeAi());
  const reserve = async (lookups: boolean) => {
    const baseInput = inputTokensUpperBound(seen);
    const searchInput = search ? MAX_SEARCHES * SEARCH_INPUT_TOKENS : 0;
    const lookupInput = lookups
      ? MAX_CHAT_SEARCHES * (baseInput + fileTokens + searchInput) +
        CHAT_SEARCH_RESULT_TOKENS * ((MAX_CHAT_SEARCHES * (MAX_CHAT_SEARCHES + 1)) / 2)
      : 0;
    const plan = planReply(modelsThatMayAnswer(model), baseInput, {
      // Web searches have a fee each, and the pages they read come back as extra input.
      extraUsd: search ? Math.max(...modelsThatMayAnswer(model).map((m) => searchCost(m.provider, MAX_SEARCHES))) : 0,
      extraInputTokens: searchInput + fileTokens + lookupInput,
    });
    const { data, error } = await admin.rpc("reserve_spend", { p_person: me.userId, p_want: plan.want, p_need: plan.need });
    return { plan, hold: (data as { hold_id: string; amount_usd: number }[] | null)?.[0], error };
  };
  let reserved = await reserve(mayLookUp);
  if (!reserved.hold && mayLookUp && reserved.error?.code === "P0001") {
    // Too close to the limit for lookups: answer without them rather than refusing.
    mayLookUp = false;
    reserved = await reserve(false);
  }
  const { plan, hold, error: holdError } = reserved;
  if (!hold) {
    return fail(402, holdError?.code === "P0001" ? `${holdError.message}.` : "Couldn't check your spending limit. Try again.");
  }
  const release = () =>
    admin.rpc("settle_spend", {
      p_hold: hold.hold_id, p_message: null, p_provider: model.provider, p_model: model.id, p_input: 0, p_output: 0, p_cost: 0,
    });
  const maxOutput = plan.maxOutput(Number(hold.amount_usd));

  if (!chatId) {
    const { data: chat, error } = await db
      .from("chats")
      .insert({ owner_id: me.userId, title: titleFrom(text || fileRefs[0]?.name || ""), model: model.id })
      .select("id")
      .single<{ id: string }>();
    if (error || !chat) {
      await release();
      return fail(500, "Couldn't start a chat. Try again.");
    }
    chatId = chat.id;
  }

  // The question being answered.
  let question: MessageRow;
  if (body.regenerate) {
    const q = all.find((m) => m.id === body.regenerate && m.role === "user");
    if (!q) {
      await release();
      return fail(404, "That message doesn't exist.");
    }
    question = q;
  } else {
    const parent = parentGiven ? (body.parent ? all.find((m) => m.id === body.parent) : undefined) : activePath(all).at(-1);
    const { data: inserted, error } = await db
      .from("messages")
      .insert({
        chat_id: chatId,
        owner_id: me.userId,
        parent_id: parent?.id ?? null,
        role: "user",
        content: fileRefs.length ? { text, files: fileRefs.map(({ path, name, mime, size }) => ({ path, name, mime, size })) } : { text },
        client_request_id: body.clientRequestId,
      })
      .select("id, chat_id, parent_id, role, content, status, model, created_at")
      .single<MessageRow>();
    if (error || !inserted) await release();
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
  // Messages the model gets word for word (or that have nothing to send); the rest can be looked up.
  const sent = new Set<string>([question.id]);
  let budget = HISTORY_CHARS;
  let fileBudget = FILE_BYTES_BUDGET;
  const storage = supabaseAdmin().storage.from(UPLOAD_BUCKET);
  for (const m of [...path].reverse()) {
    let t = m.content.text ?? "";
    const attached: TurnFile[] = [];
    if (m.role === "user") {
      for (const f of m.content.files ?? []) {
        // Only ever the sender's own folder, even if a stored message says otherwise.
        if (!isFileRef(f, me.userId)) continue;
        const fits = readAsText(f.mime) ? budget - f.size > 0 : fileBudget - f.size > 0;
        const { data: blob } = fits ? await storage.download(f.path) : { data: null };
        if (!blob) {
          t += `\n\n[Attached file "${f.name}" is ${fits ? "no longer available: files are removed after 3 days without use" : "too large to send again"}.]`;
        } else if (readAsText(f.mime)) {
          // Word, Excel and PowerPoint files are read here, as no provider takes them directly.
          const body =
            f.mime === "text/plain"
              ? (await blob.text()).slice(0, 200_000)
              : await documentText(f.mime, new Uint8Array(await blob.arrayBuffer())).catch(() => null);
          const name = f.name.replace(/"/g, "'");
          if (body === null) t += `\n\n[Attached file "${name}" couldn't be read. It may be damaged or password-protected.]`;
          else {
            budget -= body.length;
            t += `\n\n<file name="${name}">\n${body || "(This file has no text in it.)"}\n</file>`;
          }
        } else {
          fileBudget -= f.size;
          attached.push({ name: f.name, mime: f.mime, data: Buffer.from(await blob.arrayBuffer()).toString("base64") });
        }
      }
    }
    t = t.trim();
    if ((!t && !attached.length) || m.role === "system" || (m.role === "assistant" && m.status === "failed")) {
      sent.add(m.id);
      continue;
    }
    if (budget - t.length < 0 && turns.length) break;
    budget -= t.length;
    sent.add(m.id);
    // Providers expect turns to alternate, so two in a row from one side are joined.
    if (turns[0]?.role === m.role) {
      turns[0] = { ...turns[0], text: [t, turns[0].text].filter(Boolean).join("\n\n"), files: [...attached, ...(turns[0].files ?? [])] };
    } else turns.unshift({ role: m.role as Turn["role"], text: t, files: attached.length ? attached : undefined });
  }
  while (turns[0]?.role === "assistant") turns.shift();
  // The question itself is in front of the model, so a lookup searches everything before it.
  const earlier = path.filter((m) => m.id !== question.id);
  const chatSearch =
    mayLookUp && (shouldOfferChatSearch(earlier, sent) || fakeAi())
      ? chatSearcher(db, chatId, earlier, me.profile.display_name)
      : undefined;

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
      const memory = memoryFilter();
      let used = model;
      let notice: string | undefined;
      let usage: { input: number; output: number } | undefined;
      let sources: Source[] = [];
      let searches = 0;
      let queried = 0;
      let suggestions = "";
      let reasoning = "";
      const clock = thinkingClock();
      const queries: string[] = [];
      const lookups: string[] = [];
      // The files sent with the question, shown as "Read report.pdf".
      const read = (question.content.files ?? []).filter((f) => isFileRef(f, me.userId)).map((f) => f.name.slice(0, 200));
      let status: MessageRow["status"] = "completed";
      let error: string | undefined;
      try {
        for await (const ev of streamReply({ model, apiKey, system, turns, signal: abort.signal, search, maxOutput, chatSearch, harder })) {
          if (ev.type !== "thinking") clock.stopped();
          if (ev.type === "thinking") {
            clock.thinking();
            if (reasoning.length < MAX_REASONING_CHARS) {
              const add = ev.text.slice(0, MAX_REASONING_CHARS - reasoning.length);
              reasoning += add;
              send({ type: "thinking", text: add });
            }
          } else if (ev.type === "text") {
            // A suggested memory is taken out of the reply and offered separately.
            const shown = memory.push(ev.text);
            if (shown) {
              reply += shown;
              send({ type: "text", text: shown });
            }
          } else if (ev.type === "usage") usage = { input: ev.input, output: ev.output };
          else if (ev.type === "model") used = findModel(ev.id) ?? model;
          else if (ev.type === "searching") {
            // Looking back through this chat is free; only web searches have a fee.
            if (ev.query && ev.where !== "chat") queried++;
            const list = ev.where === "chat" ? lookups : queries;
            if (ev.query && list.length < MAX_QUERIES && !list.includes(ev.query)) list.push(ev.query);
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

      clock.stopped();
      const tail = memory.end();
      if (tail) {
        reply += tail;
        send({ type: "text", text: tail });
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
            ...(harder ? { harder: true } : {}),
            ...(reasoning.trim() ? { reasoning, thoughtMs: clock.ms } : {}),
            ...(queries.length ? { queries } : {}),
            ...(lookups.length ? { lookups } : {}),
            ...(read.length ? { read } : {}),
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
        // Swap the hold for what the reply really cost.
        admin.rpc("settle_spend", {
          p_hold: hold.hold_id,
          p_message: saved?.id ?? null,
          p_provider: used.provider,
          p_model: used.id,
          p_input: usage.input,
          p_output: usage.output,
          p_cost: Number(cost.toFixed(6)),
        }),
        admin.from("chats").update({ updated_at: now, model: model.id }).eq("id", finalChatId),
        admin.from("profiles").update({ last_model: model.id }).eq("id", me.userId),
      ]);

      // A suggested memory waits for the person to keep or dismiss it; nothing is used until then.
      const fact = status === "completed" ? memory.suggestions[0] : undefined;
      if (saved && fact) {
        const { data: suggested } = await admin
          .from("memories")
          .insert({ owner_id: me.userId, content: fact, status: "suggested", source_message_id: saved.id })
          .select("id, content")
          .single<{ id: string; content: string }>();
        if (suggested) saved.memory = suggested;
      }

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

/** About how many input tokens the pages from one web search add, erring high. */
const SEARCH_INPUT_TOKENS = 12_000;

/** How a model makes a file to download (shown by components/markdown/FileCard.tsx). */
const FILE_INSTRUCTIONS = [
  "You can make files to download.",
  "When asked for a document, spreadsheet or other file (Word, PDF, Excel, CSV, Markdown, text or JSON), write the whole file in one fenced code block labelled file: and its name, for example ```file:Trip-plan.docx, and the app shows it with a Download button; never say you can't make files.",
  "Inside, write Markdown for .docx, .pdf and .md; CSV with a heading row for .csv and .xlsx (for several sheets, put each under a line like ## Sheet: Name; Excel formulas such as =SUM(B2:B9) work in .xlsx); plain text for .txt and .json.",
  "Use a short file name without spaces. If the file contains ``` fences, open and close the file block with ```` instead. Only make a file when one is wanted, and keep remarks outside the block.",
].join(" ");

function systemPrompt(name: string, voice: boolean, memories: string[]): string {
  return [
    `You are a helpful assistant inside Depeche, a private chat app for a family and friends. You're talking with ${name}.`,
    `Today is ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}.`,
    "Format replies in Markdown. Write maths in LaTeX between $…$ or $$…$$. When a diagram helps, use a ```mermaid code block. Cite sources as Markdown links.",
    memoryInstructions(name, memories),
    voice ? "" : FILE_INSTRUCTIONS,
    voice
      ? "This message was spoken in voice chat and your reply will be read aloud: answer conversationally and briefly, in plain sentences, without tables, code or headings unless asked."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}
