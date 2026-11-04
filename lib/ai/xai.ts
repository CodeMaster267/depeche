import "server-only";
import OpenAI from "openai";
import { MAX_OUTPUT } from "@/lib/ai/budget";
import { pdfAsText } from "@/lib/ai/pdf-text";
import { webSource } from "@/lib/ai/sources";
import type { ReplyRequest, StreamEvent, Turn } from "@/lib/ai/providers";
import type { Source } from "@/lib/chat/thread";

/**
 * xAI's Grok, through its OpenAI-compatible Responses API, which is where xAI offers web search
 * (the `web_search` tool, $5 per 1,000 searches). Grok's reasoning stays hidden. Pictures are sent
 * as images; PDFs are turned into text here. Nothing is kept on xAI's side (`store: false`).
 *
 * Grok writes its citations into the text as [[1]](https://…); they are rewritten to Depeche's
 * [1](https://…) so they show as the same small numbered links as other providers' citations.
 */

type Content =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" };
type Input = { role: "user" | "assistant"; content: string | Content[] };

/** xAI takes JPEG and PNG pictures of up to 20 MB. */
const PICTURE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png"]);

export async function* xaiReply({ model, apiKey, system, turns, signal, search, maxOutput = MAX_OUTPUT, cacheKey }: ReplyRequest): AsyncGenerator<StreamEvent> {
  // Tests point this at a local stand-in; never on Vercel.
  const baseURL = (!process.env.VERCEL && process.env.DEPECHE_XAI_URL) || "https://api.x.ai/v1";
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });
  const stream = await client.responses.create(
    {
      model: model.id,
      instructions: system,
      input: (await xaiInput(turns)) as never,
      max_output_tokens: maxOutput,
      store: false,
      stream: true,
      // Grok caches prompts by itself; the same key for a chat sends it where its cache is.
      ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
      ...(search ? { tools: [{ type: "web_search" }] as never } : {}),
    },
    { signal },
  );

  const sources: Source[] = [];
  const seenSearches = new Set<string>();
  let searches = 0;
  let held = "";
  let wroteText = false;
  for await (const raw of stream) {
    const ev = raw as { type: string; delta?: string; item?: XaiItem; annotation?: { type?: string; url?: string; title?: string }; response?: XaiResponse; message?: string };
    if (ev.type === "response.output_text.delta" && ev.delta) {
      const { out, rest } = rewriteCites(held + ev.delta);
      held = rest;
      if (out) {
        wroteText = true;
        yield { type: "text", text: out };
      }
    } else if (ev.type === "response.output_item.added" && ev.item?.type === "web_search_call") {
      yield { type: "searching" };
    } else if (ev.type === "response.output_item.done" && ev.item?.type === "web_search_call") {
      const counted = countSearch(ev.item, seenSearches);
      if (counted.searched) searches++;
      if (counted.query) yield { type: "searching", query: counted.query };
    } else if (ev.type === "response.output_text.annotation.added") {
      addSource(sources, ev.annotation?.type === "url_citation" ? ev.annotation.url : undefined);
    } else if ((ev.type === "response.completed" || ev.type === "response.incomplete") && ev.response) {
      if (held) {
        wroteText = true;
        yield { type: "text", text: held };
        held = "";
      }
      const r = ev.response;
      for (const item of r.output ?? []) {
        if (item.type === "web_search_call" && countSearch(item, seenSearches).searched) searches++;
        for (const c of item.content ?? []) for (const a of c.annotations ?? []) if (a.type === "url_citation") addSource(sources, a.url);
      }
      for (const url of r.citations ?? []) addSource(sources, url);
      searches = Math.max(searches, reportedSearches(r));
      // Pages without a counted search still came from one, which has a fee.
      if (search && sources.length && !searches) searches = 1;
      if (!wroteText) yield { type: "notice", text: "The model sent back an empty reply. Try again." };
      if (sources.length) yield { type: "sources", sources };
      if (searches) yield { type: "searches", count: searches };
      yield { type: "usage", ...responseUsage(r.usage) };
      if (ev.type === "response.incomplete") yield { type: "notice", text: "The reply hit its length limit." };
      return;
    } else if (ev.type === "response.failed") {
      throw new Error(ev.response?.error?.message ?? "failed");
    } else if (ev.type === "error") {
      throw new Error(ev.message ?? "failed");
    }
  }
  // The stream ended without saying it was done.
  if (held) yield { type: "text", text: held };
  throw new Error("The reply stopped part way.");
}

type XaiItem = {
  type?: string;
  id?: string;
  action?: { type?: string; query?: string; queries?: string[] };
  content?: { annotations?: { type?: string; url?: string }[] }[];
};
type XaiUsage = {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens?: number;
  total_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  server_side_tool_usage_details?: Record<string, unknown>;
};
type XaiResponse = {
  output?: XaiItem[];
  citations?: string[];
  usage?: XaiUsage;
  server_side_tool_usage?: Record<string, unknown>;
  error?: { message?: string };
};

/**
 * Tokens used. Reasoning is billed as output; the total is used too, so reasoning is counted
 * whether or not xAI includes it in output_tokens. Grok caches repeated prompts by itself; the
 * cached part of the input is billed lower.
 */
export function responseUsage(u: XaiUsage | undefined): { input: number; output: number; cacheRead?: number } {
  const input = u?.input_tokens ?? 0;
  const output = Math.max(u?.output_tokens ?? 0, (u?.total_tokens ?? 0) - input);
  const cacheRead = Math.min(Math.max(0, u?.input_tokens_details?.cached_tokens ?? 0), input);
  return cacheRead ? { input, output, cacheRead } : { input, output };
}

/** Searches xAI says it billed, in whichever usage field it reports them. */
export function reportedSearches(r: XaiResponse): number {
  const fromUsage = Number(r.usage?.server_side_tool_usage_details?.web_search_calls ?? 0);
  const fromTools = Number(r.server_side_tool_usage?.SERVER_SIDE_TOOL_WEB_SEARCH ?? 0);
  return Math.max(Number.isFinite(fromUsage) ? fromUsage : 0, Number.isFinite(fromTools) ? fromTools : 0);
}

/** Counts each search once, whether it's seen as it finishes or in the final response. Opening a page isn't a search. */
function countSearch(item: XaiItem, seen: Set<string>): { searched: boolean; query?: string } {
  const query = (item.action?.query ?? item.action?.queries?.[0])?.slice(0, 200);
  if (item.action?.type && item.action.type !== "search") return { searched: false };
  const key = item.id ?? `q:${query ?? seen.size}`;
  if (seen.has(key)) return { searched: false };
  seen.add(key);
  return { searched: true, query };
}

function addSource(sources: Source[], url: string | undefined) {
  // xAI's titles are just the citation numbers, so the page's address names it instead.
  const src = webSource(url, undefined);
  if (src && !sources.some((x) => x.url === src.url)) sources.push(src);
}

/**
 * Rewrites Grok's inline citations, [[1]](https://…), to [1](https://…). A citation still arriving
 * is held back (returned as `rest`) until it is complete.
 */
export function rewriteCites(text: string): { out: string; rest: string } {
  const fixed = text.replace(/ ?\[\[(\d{1,3})\]\]\((https?:\/\/[^\s)]+)\)/g, " [$1]($2)");
  for (const start of [fixed.lastIndexOf("[["), fixed.lastIndexOf("[")].filter((i) => i >= 0).sort((a, b) => a - b)) {
    const tail = fixed.slice(start);
    if (tail.length < 600 && UNFINISHED.test(tail)) {
      // The space before it is held too, as the rewrite puts its own.
      const from = fixed.slice(0, start).endsWith(" ") ? start - 1 : start;
      return { out: fixed.slice(0, from), rest: fixed.slice(from) };
    }
  }
  return { out: fixed, rest: "" };
}

/** The start of a citation, [[1]](https://…, cut off anywhere before its closing bracket. */
const UNFINISHED = /^\[(\[(\d{1,3}(\](\](\([^\s)]*)?)?)?)?)?$/;

/** The conversation in xAI's format. PDFs become their text; pictures in the newest message are sent. */
export async function xaiInput(turns: readonly Turn[]): Promise<Input[]> {
  const input: Input[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const newest = i === turns.length - 1;
    let text = t.text;
    const images: Content[] = [];
    for (const f of t.files ?? []) {
      if (f.mime === "application/pdf") text += await pdfAsText(f.name, f.data);
      else if (t.role === "user" && newest && PICTURE_TYPES.has(f.mime)) {
        images.push({ type: "input_image", image_url: `data:${f.mime};base64,${f.data}`, detail: "auto" });
      } else text += `\n\n[Attached picture ${f.name.replace(/"/g, "'")}, not sent to this model${PICTURE_TYPES.has(f.mime) ? "" : " (Grok takes JPEG and PNG only)"}.]`;
    }
    input.push(
      images.length
        ? { role: "user", content: [...images, { type: "input_text", text: text.trim() || "What's in this picture?" }] }
        : { role: t.role, content: text.trim() || "(no text)" },
    );
  }
  return input;
}
