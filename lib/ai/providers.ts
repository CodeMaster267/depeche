import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { MAX_SEARCHES, MODELS, PROVIDER_NAME, canSearch, findModel, type Model, type Provider } from "@/lib/ai/models";
import { MAX_OUTPUT } from "@/lib/ai/budget";
import { GROQ_VISION_MODEL, groqReply } from "@/lib/ai/groq";
import type { Source } from "@/lib/chat/thread";
import { webSource } from "@/lib/ai/sources";

/**
 * One streaming interface over the providers. Depeche stores conversations in its own
 * provider-neutral shape and turns them into each provider's format here, so a chat can switch
 * models halfway through.
 */
export type Turn = { role: "user" | "assistant"; text: string; files?: TurnFile[] };

/** An image or PDF sent with a turn, base64 encoded. Text files are put into the turn's text. */
export type TurnFile = { name: string; mime: string; data: string };

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "usage"; input: number; output: number }
  | { type: "notice"; text: string }
  /** Another model answered (the chosen one was busy). */
  | { type: "model"; id: string }
  /** The model is searching the web, for this query when the provider says. */
  | { type: "searching"; query?: string }
  /** Pages the search found or the reply cited. */
  | { type: "sources"; sources: Source[] }
  /** How many searches were run in total (each has a fee). */
  | { type: "searches"; count: number }
  /** Google's search suggestions HTML, which its terms require showing with grounded replies. */
  | { type: "suggestions"; html: string };

export type ReplyRequest = {
  model: Model;
  apiKey: string;
  system: string;
  turns: Turn[];
  signal: AbortSignal;
  /** Let the model search the web with the provider's own search tool when it decides to. */
  search?: boolean;
  /** The longest reply allowed, so it fits what was reserved against the person's limit. */
  maxOutput?: number;
};

/** A provider error, worded for the person chatting. */
export class ProviderError extends Error {}


/**
 * When a model is overloaded (Google's free tier often says "high demand"), try again twice, then
 * let a lighter model from the same provider answer instead and say so.
 */
const BUSY_FALLBACK: Record<string, string> = {
  "gemini-3.8-flash": "gemini-3.5-flash-lite",
  "gemini-4-argon": "gemini-3.8-flash",
  "gemini-3.5-flash-lite": "gemini-3.8-flash",
  // Groq's free-tier limits are per model, so a sibling model can answer when one is used up.
  "openai/gpt-oss-120b": "openai/gpt-oss-20b",
  "openai/gpt-oss-20b": "openai/gpt-oss-120b",
  "qwen/qwen3.8-27b": "openai/gpt-oss-120b",
};

/** Every model that might answer when this one is chosen, so a spending hold covers the dearest. */
export function modelsThatMayAnswer(model: Model): Model[] {
  const backup = findModel(BUSY_FALLBACK[model.id]);
  // On Groq, Qwen answers messages with pictures.
  const vision = model.provider === "groq" ? findModel(GROQ_VISION_MODEL) : undefined;
  return [model, backup, vision].filter((m, i, all): m is Model => !!m && all.findIndex((x) => x?.id === m.id) === i);
}

/** Groq's free tier says "rate limit reached" (429) when a model's minute or day allowance is used up. */
export function isRateLimited(e: unknown): boolean {
  return status(e) === 429 || /rate limit/i.test(detail(e));
}

export function isBusy(e: unknown): boolean {
  const code = status(e);
  return code === 500 || code === 502 || code === 503 || code === 504 || code === 529 || /overloaded|high demand|unavailable|try again later/i.test(detail(e));
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export async function* streamReply(req: ReplyRequest): AsyncGenerator<StreamEvent> {
  const attempts: { model: Model; wait: number }[] = [
    { model: req.model, wait: 0 },
    { model: req.model, wait: 1500 },
    { model: req.model, wait: 3500 },
  ];
  const backup = findModel(BUSY_FALLBACK[req.model.id]);
  if (backup) attempts.push({ model: backup, wait: 0 });

  let lastError: unknown;
  let search = !!req.search && canSearch(req.model);
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    if (attempt.wait) await pause(attempt.wait, req.signal);
    if (req.signal.aborted) throw new DOMException("Aborted", "AbortError");
    let wrote = false;
    try {
      if (attempt.model.id !== req.model.id) {
        yield { type: "model", id: attempt.model.id };
        const why = isRateLimited(lastError) ? "reached its free-tier limit" : "was busy";
        yield { type: "notice", text: `${req.model.name} ${why}, so ${attempt.model.name} answered instead.` };
      }
      // Telling a model it can search without giving it the tool makes some reply with nothing.
      const r = { ...req, model: attempt.model, search, system: search ? `${req.system} ${SEARCH_HINT}` : req.system };
      const inner = fakeAi()
        ? fakeReply(r, attempt.model.id === req.model.id)
        : r.model.provider === "anthropic"
          ? anthropicReply(r)
          : r.model.provider === "openai"
            ? openaiReply(r)
            : r.model.provider === "groq"
              ? groqReply(r)
              : googleReply(r);
      for await (const ev of inner) {
        if (ev.type === "text") wrote = true;
        yield ev;
      }
      return;
    } catch (e) {
      if (req.signal.aborted) throw e;
      lastError = e;
      // Retrying after part of a reply was shown would repeat it.
      if (wrote) break;
      // Some keys or models can't search (free tiers, older models): answer without it instead.
      const groqLimit = attempt.model.provider === "groq" && isRateLimited(e);
      if (search && !isBusy(e) && !groqLimit && status(e) !== 401) {
        search = false;
        console.error("[chat] search failed, answering without it", status(e), detail(e));
        yield { type: "notice", text: searchUnavailable(attempt.model.provider, e) };
        i--;
        continue;
      }
      // A used-up Groq allowance won't come back in a few seconds: go straight to the sibling model.
      if (groqLimit) {
        const next = attempts.findIndex((a, j) => j > i && a.model.id !== attempt.model.id);
        if (next < 0) break;
        i = next - 1;
        continue;
      }
      // Other errors won't go away.
      if (!isBusy(e)) break;
    }
  }
  throw new ProviderError(describe(req.model.provider, lastError));
}

const SEARCH_HINT =
  "You can search the web. Search when the question needs current, local or specific facts you might not know; otherwise answer directly without searching.";

/** Why a search couldn't run, worded for the person chatting. */
function searchUnavailable(provider: Provider, e: unknown): string {
  const name = PROVIDER_NAME[provider];
  const said = detail(e);
  const base = "Web search wasn't available, so this answer comes from the model's own knowledge and may be out of date.";
  if (status(e) === 429 || /quota|rate limit|resource.?exhausted/i.test(said)) {
    return provider === "google"
      ? `${base} Google's search allowance for your family's key is used up. Free Google keys include little or no web search.`
      : `${base} ${name} says the key's limit is reached for now.`;
  }
  return said ? `${base} (${name} said: "${said}")` : base;
}

/** The models that fall back to another Claude model when a safety check declines a request. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]);

/** Long searches can pause a Claude turn; it is continued this many times at most. */
const MAX_CONTINUES = 3;

async function* anthropicReply({ model, apiKey, system, turns, signal, search, maxOutput = MAX_OUTPUT }: ReplyRequest): AsyncGenerator<StreamEvent> {
  const client = new Anthropic({ apiKey, maxRetries: 1 });
  const fallback = FALLBACK_MODELS.has(model.id);
  type Msg = { role: "user" | "assistant"; content: unknown };
  const messages: Msg[] = turns.map((t) =>
    t.files?.length
      ? {
          role: t.role,
          content: [
            ...t.files.map((f) =>
              f.mime === "application/pdf"
                ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data }, title: f.name }
                : { type: "image", source: { type: "base64", media_type: f.mime, data: f.data } },
            ),
            ...(t.text ? [{ type: "text", text: t.text }] : []),
          ],
        }
      : { role: t.role, content: t.text || "(no text)" },
  );
  let input = 0;
  let output = 0;
  let searches = 0;
  const cited: Source[] = [];
  const found: Source[] = [];
  for (let round = 0; round <= MAX_CONTINUES; round++) {
    const stream = client.beta.messages.stream(
      {
        model: model.id,
        max_tokens: maxOutput,
        system,
        messages: messages as never,
        output_config: { effort: "medium" },
        ...(search ? { tools: [{ type: "web_search_20250305" as const, name: "web_search" as const, max_uses: MAX_SEARCHES }] } : {}),
        ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as never } : {}),
      },
      { signal },
    );
    // A search's query arrives in pieces; the cited pages of a text block arrive alongside its text.
    const queryJson = new Map<number, string>();
    const blockCites = new Map<number, Source[]>();
    for await (const ev of stream) {
      if (ev.type === "content_block_start") {
        const b = ev.content_block;
        if (b.type === "server_tool_use" && b.name === "web_search") {
          queryJson.set(ev.index, "");
          yield { type: "searching" };
        } else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
          for (const r of b.content) {
            const src = webSource(r.url, r.title);
            if (src) found.push(src);
          }
        }
      } else if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") yield { type: "text", text: ev.delta.text };
        else if (ev.delta.type === "input_json_delta" && queryJson.has(ev.index)) {
          queryJson.set(ev.index, queryJson.get(ev.index) + ev.delta.partial_json);
        } else if (ev.delta.type === "citations_delta" && ev.delta.citation.type === "web_search_result_location") {
          const src = webSource(ev.delta.citation.url, ev.delta.citation.title);
          if (src) blockCites.set(ev.index, [...(blockCites.get(ev.index) ?? []), src]);
        }
      } else if (ev.type === "content_block_stop") {
        if (queryJson.has(ev.index)) {
          let query: string | undefined;
          try {
            query = (JSON.parse(queryJson.get(ev.index) || "{}") as { query?: string }).query;
          } catch {
            // The query is only shown, so a malformed one is skipped.
          }
          if (query) yield { type: "searching", query: query.slice(0, 200) };
          queryJson.delete(ev.index);
        }
        // Numbered links after the sentence they back up, like [1](https://…).
        const cites = blockCites.get(ev.index);
        if (cites?.length) {
          const marks = new Set<number>();
          for (const c of cites) {
            let n = cited.findIndex((x) => x.url === c.url);
            if (n < 0) n = cited.push(c) - 1;
            marks.add(n + 1);
          }
          yield { type: "text", text: [...marks].map((n) => ` [${n}](${cited[n - 1].url})`).join("") };
          blockCites.delete(ev.index);
        }
      }
    }
    const final = await stream.finalMessage();
    const u = final.usage;
    input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    output += u.output_tokens ?? 0;
    searches += u.server_tool_use?.web_search_requests ?? 0;
    if (final.stop_reason === "pause_turn" && round < MAX_CONTINUES) {
      // The search ran long: hand Claude back what it has so far and let it carry on.
      messages.push({ role: "assistant", content: final.content });
      continue;
    }
    if (final.stop_reason === "refusal") yield { type: "notice", text: "The model declined to answer this." };
    if (final.stop_reason === "max_tokens") yield { type: "notice", text: "The reply hit its length limit." };
    break;
  }
  if (search) {
    // Cited pages first, then the other pages the searches turned up.
    const sources = [...cited, ...found.filter((f) => !cited.some((c) => c.url === f.url))];
    if (sources.length) yield { type: "sources", sources };
    if (searches) yield { type: "searches", count: searches };
  }
  yield { type: "usage", input, output };
}

async function* openaiReply({ model, apiKey, system, turns, signal, search, maxOutput = MAX_OUTPUT }: ReplyRequest): AsyncGenerator<StreamEvent> {
  const client = new OpenAI({ apiKey, maxRetries: 1 });
  const stream = await client.responses.create(
    {
      model: model.id,
      instructions: system,
      input: turns.map((t) =>
        t.role === "user" && t.files?.length
          ? {
              role: "user" as const,
              content: [
                ...t.files.map((f) =>
                  f.mime === "application/pdf"
                    ? { type: "input_file" as const, filename: f.name, file_data: `data:application/pdf;base64,${f.data}` }
                    : { type: "input_image" as const, image_url: `data:${f.mime};base64,${f.data}`, detail: "auto" as const },
                ),
                ...(t.text ? [{ type: "input_text" as const, text: t.text }] : []),
              ],
            }
          : { role: t.role, content: t.text },
      ),
      max_output_tokens: maxOutput,
      store: false,
      stream: true,
      ...(search ? { tools: [{ type: "web_search" as const }], max_tool_calls: MAX_SEARCHES } : {}),
    },
    { signal },
  );
  const sources: Source[] = [];
  let searches = 0;
  for await (const ev of stream) {
    if (ev.type === "response.output_text.delta") yield { type: "text", text: ev.delta };
    else if (ev.type === "response.output_item.added" && ev.item.type === "web_search_call") yield { type: "searching" };
    else if (ev.type === "response.output_item.done" && ev.item.type === "web_search_call") {
      const action = ev.item.action as { type?: string; query?: string; queries?: string[] } | undefined;
      if (action?.type === "search") {
        searches++;
        const query = action.query ?? action.queries?.[0];
        if (query) yield { type: "searching", query: query.slice(0, 200) };
      }
    } else if (ev.type === "response.output_text.annotation.added") {
      const a = ev.annotation as { type?: string; url?: string; title?: string };
      const src = a?.type === "url_citation" ? webSource(a.url, a.title) : null;
      if (src && !sources.some((x) => x.url === src.url)) sources.push(src);
    } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
      const u = ev.response.usage;
      // Searches that only opened or scanned a page aren't billed as searches.
      const calls = (ev.response.output ?? []).filter(
        (o) => o.type === "web_search_call" && (o.action as { type?: string } | undefined)?.type === "search",
      ).length;
      searches = Math.max(searches, calls);
      if (sources.length) yield { type: "sources", sources };
      if (searches) yield { type: "searches", count: searches };
      yield { type: "usage", input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0 };
      if (ev.type === "response.incomplete") yield { type: "notice", text: "The reply was cut short." };
    } else if (ev.type === "response.failed") {
      throw new Error(ev.response.error?.message ?? "failed");
    } else if (ev.type === "error") {
      throw new Error(ev.message);
    }
  }
}

async function* googleReply({ model, apiKey, system, turns, signal, search, maxOutput = MAX_OUTPUT }: ReplyRequest): AsyncGenerator<StreamEvent> {
  const ai = new GoogleGenAI({ apiKey });
  const stream = await ai.models.generateContentStream({
    model: model.id,
    contents: turns.map((t) => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [
        ...(t.files ?? []).map((f) => ({ inlineData: { mimeType: f.mime, data: f.data } })),
        ...(t.text || !t.files?.length ? [{ text: t.text }] : []),
      ],
    })),
    config: {
      systemInstruction: system,
      maxOutputTokens: maxOutput,
      abortSignal: signal,
      ...(search ? { tools: [{ googleSearch: {} }] } : {}),
    },
  });
  let input = 0;
  let output = 0;
  const sources: Source[] = [];
  const queries = new Set<string>();
  let suggestions = "";
  let wroteText = false;
  let finish = "";
  for await (const chunk of stream) {
    const candidate = chunk.candidates?.[0];
    const text = candidate?.content?.parts
      ?.filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("");
    if (text) {
      wroteText = true;
      yield { type: "text", text };
    }
    if (candidate?.finishReason) finish = String(candidate.finishReason);
    const g = candidate?.groundingMetadata;
    if (g) {
      for (const q of g.webSearchQueries ?? []) {
        if (q && !queries.has(q)) {
          queries.add(q);
          yield { type: "searching", query: q.slice(0, 200) };
        }
      }
      for (const c of g.groundingChunks ?? []) {
        const src = webSource(c.web?.uri, c.web?.title, c.web?.domain ?? c.web?.title);
        if (src && !sources.some((x) => x.url === src.url)) sources.push(src);
      }
      if (g.searchEntryPoint?.renderedContent) suggestions = g.searchEntryPoint.renderedContent;
    }
    const u = chunk.usageMetadata;
    if (u) {
      input = u.promptTokenCount ?? input;
      output = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) || output;
    }
  }
  // A reply with no text at all says why, rather than leaving an empty space.
  if (!wroteText) yield { type: "notice", text: `The model sent back an empty reply${finish && finish !== "STOP" ? ` (${finish.toLowerCase().replace(/_/g, " ")})` : ""}. Try again.` };
  if (sources.length) yield { type: "sources", sources };
  // Google bills each search query the model runs.
  if (queries.size || sources.length) yield { type: "searches", count: Math.max(queries.size, 1) };
  if (suggestions) yield { type: "suggestions", html: suggestions.slice(0, 20_000) };
  yield { type: "usage", input, output };
}

function status(e: unknown): number | undefined {
  const s = (e as { status?: unknown; code?: unknown })?.status ?? (e as { code?: unknown })?.code;
  return typeof s === "number" ? s : undefined;
}

/** The provider's own explanation, unwrapped from the JSON some SDKs nest it in. */
function detail(e: unknown): string {
  let msg = e instanceof Error ? e.message : String(e ?? "");
  for (let i = 0; i < 3; i++) {
    try {
      const parsed = JSON.parse(msg.slice(msg.indexOf("{"))) as { error?: { message?: string }; message?: string };
      const inner = parsed.error?.message ?? parsed.message;
      if (typeof inner !== "string" || inner === msg) break;
      msg = inner;
    } catch {
      break;
    }
  }
  const cause = (e as { cause?: unknown })?.cause;
  if (cause instanceof Error && !msg.includes(cause.message)) msg += ` (${cause.message})`;
  return msg.replace(/\s+/g, " ").trim().slice(0, 240);
}

function describe(provider: Provider, e: unknown): string {
  const text = friendlyError(provider, e);
  const said = detail(e);
  // Logged for debugging in Vercel; never includes the key.
  console.error(`[chat] ${provider} error`, status(e), said);
  const name = PROVIDER_NAME[provider];
  return said ? `${text} (${name} said: "${said}")` : text;
}

function friendlyError(provider: Provider, e: unknown): string {
  const name = PROVIDER_NAME[provider];
  const code = status(e);
  const msg = detail(e);
  if (code === 401 || code === 403 || /api key|unauthori[sz]ed|permission/i.test(msg))
    return `${name} didn't accept your family's key. Ask your family admin to check it in Family settings.`;
  if (provider === "google" && (code === 429 || /quota|rate limit|resource.?exhausted/i.test(msg)))
    return "Google's limit for this key is reached for now. Free keys allow only a few messages a minute and some models not at all. Wait a minute, or pick a Flash model.";
  if (provider === "groq" && (code === 413 || /request too large/i.test(msg)))
    return "This chat is too long for Groq's free tier, which takes only about 8,000 tokens (roughly 6,000 words) a minute. Start a new chat, or pick another model.";
  if (provider === "groq" && (code === 429 || /rate limit/i.test(msg))) {
    const wait = /try again in ([\d.]+)(m?s)/i.exec(msg);
    const when = wait ? ` Try again in ${wait[2] === "ms" ? "a second" : `${Math.ceil(Number(wait[1]))} seconds`}.` : " Wait a minute and try again.";
    return /per day|\(RPD\)|\(TPD\)/i.test(msg)
      ? "Groq's free-tier allowance for today is used up on these models. Pick another model, or try again tomorrow."
      : `Groq's free tier allows only so much a minute, and that's used up.${when}`;
  }
  if (code === 429 || /quota|rate limit|credit|billing/i.test(msg))
    return `${name} says the key is out of credit or busy. Try again in a minute, or ask your family admin to check billing.`;
  if (isBusy(e)) return `${name}'s servers are very busy right now, even after a few tries. Wait a minute, or pick another model.`;
  if (code === 404) return `${name} doesn't offer this model to your family's key. Try another model.`;
  if (code === 400) return `${name} couldn't take this request. Try a shorter message or another model.`;
  return `${name} had a problem answering. Try again.`;
}

/** Checks a key with a free request (listing models) before it is saved. */
/**
 * Asks the provider which models a key can see, using free model-list calls. Returns the ids
 * Depeche offers that the key can use, or null if the provider refused the key.
 */
export async function listKeyModels(provider: Provider, key: string): Promise<string[] | null> {
  const ours = MODELS.filter((m) => m.provider === provider).map((m) => m.id);
  if (fakeAi()) {
    if (!key.startsWith("test-")) return null;
    // A key with "free" in it stands in for a free-tier key that can't use the paid-only models.
    return key.includes("free") ? ours.filter((id) => id !== "gemini-4-argon") : ours;
  }
  const signal = AbortSignal.timeout(10_000);
  try {
    const seen = new Set<string>();
    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
        signal,
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      if (!res.ok) return res.status === 401 || res.status === 403 ? null : ours;
      for (const m of ((await res.json()).data ?? []) as { id: string }[]) seen.add(m.id);
    } else if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/models", { signal, headers: { authorization: `Bearer ${key}` } });
      if (!res.ok) return res.status === 401 || res.status === 403 ? null : ours;
      for (const m of ((await res.json()).data ?? []) as { id: string }[]) seen.add(m.id);
    } else if (provider === "groq") {
      const res = await fetch("https://api.groq.com/openai/v1/models", { signal, headers: { authorization: `Bearer ${key}` } });
      if (!res.ok) return res.status === 401 || res.status === 403 ? null : ours;
      for (const m of ((await res.json()).data ?? []) as { id: string }[]) seen.add(m.id);
    } else {
      let page = "";
      for (let i = 0; i < 5; i++) {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`,
          { signal, headers: { "x-goog-api-key": key } },
        );
        if (!res.ok) return res.status === 400 || res.status === 401 || res.status === 403 ? null : ours;
        const body = (await res.json()) as { models?: { name: string }[]; nextPageToken?: string };
        for (const m of body.models ?? []) seen.add(m.name.replace(/^models\//, ""));
        if (!body.nextPageToken) break;
        page = body.nextPageToken;
      }
    }
    const usable = ours.filter((id) => seen.has(id));
    // If none of our names match, the provider has probably renamed things; better to offer
    // everything than nothing.
    return usable.length ? usable : ours;
  } catch {
    return null;
  }
}

export async function checkKey(provider: Provider, key: string): Promise<boolean> {
  return (await listKeyModels(provider, key)) !== null;
}

/**
 * Browser tests run against a stand-in that streams a fixed rich reply, so they never call a real
 * provider or spend money. Only possible on a local machine or in CI, never on Vercel.
 */
export function fakeAi(): boolean {
  return process.env.DEPECHE_FAKE_AI === "1" && !process.env.VERCEL;
}

const FAKE_REPLY = String.raw`Here's a worked answer to "{q}".

## The formula

The quadratic formula solves $ax^2 + bx + c = 0$:

$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$

| Step | Working | Result |
| --- | --- | --- |
| Discriminant | $(-7)^2 - 4(2)(3)$ | 25 |
| Roots | $(7 \pm 5)/4$ | 3 and 0.5 |

| Method | When it works | Effort | Exact answer | Notes |
| --- | --- | --- | --- | --- |
| **Quadratic formula** | Always, for any real coefficients | Low | Yes | The dependable default when factoring isn't obvious |
| Completing the square | Always | Medium | Yes | Shows where the formula comes from |
| Graphing | Approximate roots only | Low | No | Useful for checking an answer by eye |

\`\`\`python
import math

def solve(a, b, c):
    d = b**2 - 4*a*c
    return [(-b + math.sqrt(d)) / (2*a), (-b - math.sqrt(d)) / (2*a)]
\`\`\`

\`\`\`mermaid
graph TD
  D[Discriminant] -->|positive| T[Two real roots]
  D -->|zero| O[One root]
  D -->|negative| N[No real roots]
\`\`\`

> Check: $2(3)^2 - 7(3) + 3 = 0$.

This is well documented[^1].

[^1]: [Quadratic formula](https://en.wikipedia.org/wiki/Quadratic_formula), Wikipedia.
`.replaceAll("\\`", "`");

async function* fakeReply({ turns, signal, search, model, system }: ReplyRequest, chosen = true): AsyncGenerator<StreamEvent> {
  const last = turns.at(-1);
  const q = last?.text.slice(0, 80) ?? "";
  // Asked to summarise a chat (auto-compaction): a short summary naming the first message, and facts.
  if (system.startsWith("You summarise conversations for Depeche")) {
    const first = /\[[^\]]+\]\n([^\n]{0,60})/.exec(last?.text ?? "")?.[1] ?? "";
    const reply = `<summary>Earlier in this chat they talked about "${first}" and more.</summary>\n<facts>\n- The secret number is 4417.\n</facts>`;
    await new Promise((r) => setTimeout(r, q.includes("slowly") ? 1500 : 30));
    yield { type: "text", text: reply };
    yield { type: "usage", input: Math.ceil((last?.text.length ?? 0) / 4), output: 60 };
    return;
  }
  // Like Gemini, told it can search but given no search tool, it answers with nothing.
  if (!search && system.includes("You can search the web")) {
    yield { type: "usage", input: 100, output: 0 };
    return;
  }
  // "busy" in the message makes the chosen model act overloaded, to test retries and the fallback.
  // "ratelimit" makes a Groq model act as if its free-tier allowance is used up; "ratelimitall" does
  // the same for the model that steps in, to test the fallback and the final error.
  if (model.provider === "groq" && (q.includes("ratelimitall") || (chosen && q.includes("ratelimit")))) {
    throw Object.assign(
      new Error(`Rate limit reached for model \`${model.id}\` in organization \`org_test\` service tier \`on_demand\` on requests per minute (RPM): Limit 30, Used 30, Requested 1. Please try again in 2.5s.`),
      { status: 429 },
    );
  }
  if (chosen && q.includes("busy")) throw Object.assign(new Error("This model is currently experiencing high demand."), { status: 503 });
  // "latest" with search on makes it search the web first, to test sources and search fees.
  if (search && q.includes("latest")) {
    if (q.includes("nosearch")) throw Object.assign(new Error("Search grounding is not supported for this key."), { status: 400 });
    if (q.includes("noquota")) throw Object.assign(new Error("You exceeded your current quota, please check your plan and billing details."), { status: 429 });
    yield { type: "searching" };
    await new Promise((r) => setTimeout(r, q.includes("slowly") ? 1500 : 50));
    yield { type: "searching", query: q.slice(0, 60) };
    const sources: Source[] = [
      { url: "https://en.wikipedia.org/wiki/Quadratic_formula", title: "Quadratic formula - Wikipedia" },
      { url: "https://www.bbc.co.uk/news/science", title: "Science news", domain: "bbc.co.uk" },
      { url: "https://www.nature.com/news", title: "Nature news" },
    ];
    const text = `Here's what I found on the web. The quadratic formula is centuries old [1](${sources[0].url}), and it still appears in the news [2](${sources[1].url}).`;
    for (let i = 0; i < text.length; i += 24) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      await new Promise((r) => setTimeout(r, 8));
      yield { type: "text", text: text.slice(i, i + 24) };
    }
    yield { type: "sources", sources };
    yield { type: "searches", count: 2 };
    if (model.provider === "google") {
      yield { type: "suggestions", html: '<style>.c{font:14px sans-serif}</style><div class="c"><a href="https://www.google.com/search?q=quadratic">quadratic formula</a><script>parent.document.title="pwned"</script></div>' };
    }
    yield { type: "usage", input: 3000, output: 200 };
    return;
  }
  // Say which files arrived, so tests can check that attachments reach the model.
  const seen = [...(last?.files ?? []).map((f) => f.name), ...[...(last?.text ?? "").matchAll(/<file name="([^"]+)">/g)].map((m) => m[1])];
  // "favourite colour" makes it suggest a memory, to test memory suggestions.
  const remember = q.includes("favourite colour") ? "\n\n<remember>Their favourite colour is black.</remember>" : "";
  const reply = (seen.length ? `I can see ${seen.join(", ")}.\n\n` : "") + FAKE_REPLY.replace("{q}", q) + remember;
  const slow = q.includes("slowly");
  for (let i = 0; i < reply.length; i += 24) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    await new Promise((r) => setTimeout(r, slow ? 120 : 8));
    yield { type: "text", text: reply.slice(i, i + 24) };
  }
  yield { type: "usage", input: 1200, output: 400 };
}
