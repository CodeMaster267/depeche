import "server-only";
import OpenAI from "openai";
import { MAX_OUTPUT } from "@/lib/ai/budget";
import { findModel } from "@/lib/ai/models";
import { pdfAsText } from "@/lib/ai/pdf-text";
import type { ReplyRequest, StreamEvent, Turn } from "@/lib/ai/providers";

/**
 * DeepSeek, through its OpenAI-compatible Chat Completions API. Its models think before answering
 * (on by default); the thinking streams separately as `reasoning_content` and is kept out of the
 * reply. DeepSeek's API has no web search. Only Flash sees pictures, so it answers a message that
 * has some; PDFs are turned into text here, as no DeepSeek model reads them.
 */

export const DEEPSEEK_VISION_MODEL = "deepseek-flash";
/** DeepSeek takes up to 48 MB a request; Depeche's uploads stay well under that. */
const MAX_IMAGES = 20;

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type Msg = { role: "system" | "user" | "assistant"; content: string | Part[] };

export async function* deepseekReply(req: ReplyRequest): AsyncGenerator<StreamEvent> {
  let model = req.model;
  const { apiKey, system, turns, signal, maxOutput = MAX_OUTPUT } = req;
  const pictures = (turns.at(-1)?.files ?? []).filter((f) => f.mime.startsWith("image/"));
  const vision = findModel(DEEPSEEK_VISION_MODEL);
  if (pictures.length && model.id !== DEEPSEEK_VISION_MODEL && vision) {
    yield { type: "model", id: vision.id };
    yield { type: "notice", text: `${model.name} can't see pictures, so ${vision.name} answered instead.` };
    model = vision;
  }
  // No search tool, so the search hint is left out.
  const prompt = system.replace(/\s*You can search the web\..*$/s, "");
  const messages = await deepseekMessages(prompt, turns, model.id === DEEPSEEK_VISION_MODEL);

  // Tests point this at a local stand-in; never on Vercel.
  const baseURL = (!process.env.VERCEL && process.env.DEPECHE_DEEPSEEK_URL) || "https://api.deepseek.com";
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });
  const stream = await client.chat.completions.create(
    {
      model: model.id,
      messages: messages as never,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxOutput,
    },
    { signal },
  );

  let input = 0;
  let output = 0;
  let wroteText = false;
  let finish = "";
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    const text = choice?.delta?.content;
    if (text) {
      wroteText = true;
      yield { type: "text", text };
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (chunk.usage) ({ input, output } = completionUsage(chunk.usage));
  }
  if (!wroteText) yield { type: "notice", text: "The model sent back an empty reply. Try again." };
  if (finish === "length") yield { type: "notice", text: "The reply hit its length limit." };
  if (finish === "content_filter") yield { type: "notice", text: "DeepSeek stopped this reply with its content filter." };
  if (finish === "insufficient_system_resource") yield { type: "notice", text: "DeepSeek ran short of capacity and cut the reply off. Try again." };
  yield { type: "usage", input, output };
}

/**
 * Tokens used. Thinking is billed as output; it is part of completion_tokens on DeepSeek, but the
 * total is used as well so it is counted whichever way it's reported.
 */
export function completionUsage(u: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): { input: number; output: number } {
  const input = u.prompt_tokens ?? 0;
  const output = Math.max(u.completion_tokens ?? 0, (u.total_tokens ?? 0) - input);
  return { input, output };
}

/** The conversation in DeepSeek's format. Pictures in the newest message go to Flash; the rest are named. */
export async function deepseekMessages(system: string, turns: readonly Turn[], seesPictures: boolean): Promise<Msg[]> {
  const messages: Msg[] = [{ role: "system", content: system }];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const newest = i === turns.length - 1;
    let text = t.text;
    const images: Part[] = [];
    for (const f of t.files ?? []) {
      if (f.mime === "application/pdf") text += await pdfAsText(f.name, f.data);
      else if (f.mime.startsWith("image/") && newest && seesPictures && images.length < MAX_IMAGES) {
        images.push({ type: "image_url", image_url: { url: `data:${f.mime};base64,${f.data}` } });
      } else text += `\n\n[Attached picture ${f.name.replace(/"/g, "'")}, not sent to this model.]`;
    }
    messages.push({
      role: t.role,
      content: images.length ? [{ type: "text", text: text.trim() || "What's in this picture?" }, ...images] : text.trim() || "(no text)",
    });
  }
  return messages;
}
