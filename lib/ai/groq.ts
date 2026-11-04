import "server-only";
import OpenAI from "openai";
import { MAX_OUTPUT } from "@/lib/ai/budget";
import { findModel, type Model } from "@/lib/ai/models";
import { webSource } from "@/lib/ai/sources";
import type { ReplyRequest, StreamEvent, Turn } from "@/lib/ai/providers";
import type { Source } from "@/lib/chat/thread";

/**
 * Groq, used while Depeche is being tested on free keys. Everything Groq-specific lives here, so
 * removing Groq later means deleting this file, its entries in lib/ai/models.ts, the "groq" branch in
 * streamReply, and the unpdf dependency.
 *
 * Groq serves open models through an OpenAI-compatible Chat Completions API. Its free tier allows
 * only a few thousand input tokens a minute per model, so a request Groq calls too large is sent
 * again, cut down to fit: older messages are dropped and long files are shortened, and the reply
 * says so. Only Qwen can see pictures; PDFs are turned into text here, as no Groq model reads them.
 */

const VISION_MODEL = "qwen/qwen3.8-27b";
/** Groq takes at most 3 pictures a request, each as a base64 data URL of at most 4 MB. */
const MAX_IMAGES = 3;
const MAX_IMAGE_BASE64 = 4 * 1024 * 1024;
/** What Groq counts for one picture on Qwen. */
const IMAGE_TOKENS = 2048;
/** The free tier's allowance, if Groq's error doesn't say. */
const DEFAULT_LIMIT = 6000;

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type Msg = { role: "system" | "user" | "assistant"; content: string | Part[] };

/** Models that may answer when this Groq model is chosen: Qwen steps in for pictures. */
export const GROQ_VISION_MODEL = VISION_MODEL;

export async function* groqReply(req: ReplyRequest): AsyncGenerator<StreamEvent> {
  let model = req.model;
  const { apiKey, system, turns, signal, search, think = true, maxOutput = MAX_OUTPUT } = req;
  const pictures = (turns.at(-1)?.files ?? []).filter((f) => f.mime.startsWith("image/"));
  // Only Qwen can see pictures, so it answers a message that has some.
  const vision = findModel(VISION_MODEL);
  if (pictures.length && model.id !== VISION_MODEL && vision) {
    yield { type: "model", id: vision.id };
    yield { type: "notice", text: `${model.name} can't see pictures, so ${vision.name} answered instead.` };
    model = vision;
  }
  // The search hint only helps a model that is given the search tool.
  const prompt = search && canBrowse(model) ? system : system.replace(/\s*You can search the web\..*$/s, "");
  const built = await groqMessages(prompt, turns, model.id === VISION_MODEL);
  if (built.skipped) yield { type: "notice", text: built.skipped };

  // Tests point this at a local stand-in; never on Vercel.
  const baseURL = (!process.env.VERCEL && process.env.DEPECHE_GROQ_URL) || "https://api.groq.com/openai/v1";
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });
  const open = (messages: Msg[], maxTokens?: number) =>
    client.chat.completions.create(
      {
        model: model.id,
        messages: messages as never,
        stream: true,
        stream_options: { include_usage: true },
        ...(maxTokens ? { max_completion_tokens: maxTokens } : {}),
        ...reasoningOptions(model, !!search, think),
        ...(search && canBrowse(model) ? { tools: [{ type: "browser_search" }] as never, tool_choice: "auto" as const } : {}),
      },
      { signal },
    );

  let stream;
  try {
    // A maximum length counts against the free tier's allowance, so it is only sent when a spending
    // hold needs a shorter reply.
    stream = await open(built.messages, maxOutput < MAX_OUTPUT ? maxOutput : undefined);
  } catch (e) {
    if (!tooLarge(e)) throw e;
    // Too much for the free tier: keep the newest messages that fit in most of the allowance, and
    // leave the rest of it for the reply.
    const limit = Number(/Limit (\d+)/i.exec(errorText(e))?.[1]) || DEFAULT_LIMIT;
    const fitted = fitMessages(built.messages, Math.floor(limit * 0.6));
    stream = await open(fitted.messages, Math.min(maxOutput, Math.floor(limit * 0.35)));
    yield {
      type: "notice",
      text: `Groq's free tier takes only about ${limit.toLocaleString("en-US")} tokens a minute, so ${fitted.note}. Pick another provider's model for long chats and files.`,
    };
  }

  let input = 0;
  let output = 0;
  let wroteText = false;
  let finish = "";
  let held = "";
  const sources: Source[] = [];
  const seenTools = new Set<string>();
  let searches = 0;
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta as { content?: string | null; reasoning?: string | null; executed_tools?: GroqTool[] } | undefined;
    if (delta?.reasoning) yield { type: "thinking", text: delta.reasoning };
    for (const tool of delta?.executed_tools ?? []) {
      const ev = groqTool(tool, seenTools, sources);
      if (ev.searched) {
        searches++;
        yield { type: "searching", ...(ev.query ? { query: ev.query } : {}) };
      }
    }
    if (delta?.content) {
      // Drop Groq's citation marks, holding back a mark until it is complete.
      const { out, rest } = stripGroqMarks(held + delta.content);
      held = rest;
      if (out) {
        wroteText = true;
        yield { type: "text", text: out };
      }
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
    // Groq reports usage on the last chunk, in its own field on older API versions.
    const u = chunk.usage ?? (chunk as { x_groq?: { usage?: typeof chunk.usage } }).x_groq?.usage;
    if (u) {
      input = u.prompt_tokens ?? input;
      output = u.completion_tokens ?? output;
    }
  }
  if (held) {
    wroteText = true;
    yield { type: "text", text: held };
  }
  if (!wroteText) yield { type: "notice", text: "The model sent back an empty reply. Try again." };
  if (finish === "length") yield { type: "notice", text: "The reply hit its length limit." };
  if (sources.length) yield { type: "sources", sources };
  if (searches) yield { type: "searches", count: searches };
  yield { type: "usage", input, output };
}

function canBrowse(model: Model): boolean {
  return model.id.startsWith("openai/gpt-oss");
}

/**
 * Reasoning comes in its own field, never inside the reply text, and is shown collapsed. Groq
 * advises low effort when browsing.
 */
function reasoningOptions(model: Model, search: boolean, think: boolean): object {
  return canBrowse(model)
    ? { include_reasoning: think, reasoning_effort: search ? "low" : "medium" }
    : { reasoning_format: think ? "parsed" : "hidden" };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "");
}

function tooLarge(e: unknown): boolean {
  return (e as { status?: unknown })?.status === 413 || /request too large|reduce your message size/i.test(errorText(e));
}

/**
 * The conversation in Groq's format. PDFs become their text (no Groq model reads PDFs). Pictures in
 * the newest message go to a model that can see them, up to Groq's limits; the rest are named.
 */
export async function groqMessages(
  system: string,
  turns: readonly Turn[],
  seesPictures: boolean,
): Promise<{ messages: Msg[]; skipped?: string }> {
  const skipped: string[] = [];
  const messages: Msg[] = [{ role: "system", content: system }];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const newest = i === turns.length - 1;
    let text = t.text;
    const images: Part[] = [];
    for (const f of t.files ?? []) {
      const name = f.name.replace(/"/g, "'");
      if (f.mime === "application/pdf") {
        const body = await pdfText(f.data);
        text += body ? `\n\n<file name="${name}">\n${body}\n</file>` : `\n\n[Attached ${name}: no text could be read from this PDF.]`;
      } else if (f.mime.startsWith("image/") && newest && seesPictures && images.length < MAX_IMAGES && f.data.length <= MAX_IMAGE_BASE64) {
        images.push({ type: "image_url", image_url: { url: `data:${f.mime};base64,${f.data}` } });
      } else {
        text += `\n\n[Attached picture ${name}, not sent to this model.]`;
        if (newest) skipped.push(name);
      }
    }
    messages.push({ role: t.role, content: images.length ? [{ type: "text", text: text.trim() || "What's in this picture?" }, ...images] : text.trim() });
  }
  return {
    messages,
    skipped: skipped.length
      ? `Groq takes at most ${MAX_IMAGES} pictures of up to 4 MB each, so ${skipped.join(", ")} ${skipped.length === 1 ? "wasn't" : "weren't"} sent.`
      : undefined,
  };
}

/** The text of a PDF (base64), or "" if it has none (a scan) or can't be read. */
async function pdfText(base64: string): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(base64, "base64")));
    const { text } = await extractText(pdf, { mergePages: true });
    return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 200_000);
  } catch {
    return "";
  }
}

/** A cautious token count: Groq's tokenizers average nearer four characters a token. */
export function estimateTokens(content: Msg["content"]): number {
  if (typeof content === "string") return Math.ceil(content.length / 3) + 8;
  return content.reduce((n, p) => n + (p.type === "text" ? Math.ceil(p.text.length / 3) : IMAGE_TOKENS), 8);
}

/**
 * The system prompt, the newest message (its text shortened if needed) and as many of the messages
 * before it as fit in `budget` tokens. Says what was left out.
 */
export function fitMessages(messages: readonly Msg[], budget: number): { messages: Msg[]; note: string } {
  const [system, ...rest] = messages;
  const newest = rest.at(-1);
  if (!newest) return { messages: [...messages], note: "nothing was left out" };
  let left = budget - estimateTokens(system.content);
  let cutFile = false;
  let last = newest;
  const need = estimateTokens(newest.content);
  if (need > left) {
    // Shorten the newest message's text (usually an attached file), keeping its pictures.
    const parts: Part[] = typeof newest.content === "string" ? [{ type: "text", text: newest.content }] : newest.content;
    const pictures = parts.filter((p) => p.type === "image_url");
    const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n\n");
    const room = Math.max(200, (left - pictures.length * IMAGE_TOKENS - 40) * 3);
    const short = `${text.slice(0, room)}\n\n[The rest was cut to fit Groq's free tier.]`;
    last = { role: newest.role, content: pictures.length ? [{ type: "text", text: short }, ...pictures] : short };
    cutFile = true;
  }
  left -= estimateTokens(last.content);
  const kept: Msg[] = [];
  for (let i = rest.length - 2; i >= 0; i--) {
    const cost = estimateTokens(rest[i].content);
    if (cost > left) break;
    left -= cost;
    kept.unshift(rest[i]);
  }
  // A conversation sent to the model starts with the person, not a reply.
  while (kept[0]?.role === "assistant") kept.shift();
  const dropped = rest.length - 1 - kept.length;
  const notes = [
    ...(dropped ? [`${dropped === 1 ? "an earlier message was" : `${dropped} earlier messages were`} left out`] : []),
    ...(cutFile ? ["your message or file was shortened"] : []),
  ];
  return { messages: [system, ...kept, last], note: notes.join(" and ") || "nothing was left out" };
}

type GroqTool = {
  index?: number;
  type?: string;
  arguments?: string;
  search_results?: { results?: { title?: string; url?: string }[] };
};

/** Reads one of Groq's executed tools: whether it was a search (billed) and the pages it found. */
export function groqTool(tool: GroqTool, seen: Set<string>, sources: Source[]): { searched: boolean; query?: string } {
  for (const r of tool.search_results?.results ?? []) {
    const src = webSource(r.url, r.title);
    if (src && !sources.some((x) => x.url === src.url)) sources.push(src);
  }
  // A tool can be reported more than once as it runs; count each one once.
  const key = `${tool.index ?? ""}|${tool.type ?? ""}|${tool.arguments ?? ""}`;
  if (seen.has(key)) return { searched: false };
  seen.add(key);
  let args: { query?: unknown; q?: unknown } = {};
  try {
    args = JSON.parse(tool.arguments || "{}");
  } catch {
    // Only shown, so a malformed query is skipped.
  }
  const query = typeof args.query === "string" ? args.query : typeof args.q === "string" ? args.q : undefined;
  // Opening or scrolling a page isn't a search; only searches carry a query.
  const searched = /search/i.test(tool.type ?? "") && (!!query || !tool.arguments);
  return { searched, query: query?.slice(0, 200) };
}

/** Removes Groq browser-search citation marks (【3†L4-L9】), returning any unfinished mark separately. */
export function stripGroqMarks(text: string): { out: string; rest: string } {
  const open = text.lastIndexOf("【");
  const rest = open >= 0 && !text.includes("】", open) && text.length - open < 40 ? text.slice(open) : "";
  const body = rest ? text.slice(0, open) : text;
  return { out: body.replace(/【[^】]{0,40}】/g, ""), rest };
}
