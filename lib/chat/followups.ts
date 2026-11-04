/**
 * Follow-up questions: a model may end its reply with <followups>…</followups>, one short question
 * per line, that the person might want to ask next. The tag is taken out of the reply as it
 * streams (like <remember>) and the questions are shown as buttons under the newest answer.
 */
export const FOLLOWUPS_OPEN = "<followups>";
export const FOLLOWUPS_CLOSE = "</followups>";
export const MAX_FOLLOWUPS = 3;
export const MAX_FOLLOWUP_CHARS = 140;
/** The most of an answer someone can select and ask about. */
export const MAX_QUOTE_CHARS = 2_000;

/**
 * Strips one kind of tag from streamed text and collects what was inside. Text that might be the
 * start of the tag is held back until it's clear, so the tag never flashes on screen.
 */
export function tagFilter(open: string, close: string) {
  let held = "";
  let inside = false;
  let captured = "";
  const found: string[] = [];

  function push(chunk: string): string {
    let text = held + chunk;
    held = "";
    let out = "";
    while (text) {
      const tag = inside ? close : open;
      const at = text.indexOf(tag);
      if (at < 0) {
        const keep = partialSuffix(text, tag);
        if (inside) captured += text.slice(0, text.length - keep);
        else out += text.slice(0, text.length - keep);
        held = text.slice(text.length - keep);
        return out;
      }
      if (inside) {
        found.push(captured + text.slice(0, at));
        captured = "";
      } else out += text.slice(0, at);
      inside = !inside;
      text = text.slice(at + tag.length);
    }
    return out;
  }

  /** The end of the stream: whatever was held back is ordinary text after all. */
  function end(): string {
    // A tag the reply never closed (it was stopped, or ran out of room) still counts.
    if (inside && captured.trim()) found.push(captured);
    const rest = inside ? "" : held;
    held = "";
    captured = "";
    inside = false;
    return rest;
  }

  return { push, end, found };
}

function partialSuffix(text: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
    if (tag.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}

/** The questions inside a <followups> block: one per line, list markers and quotes taken off. */
export function parseFollowUps(raw: string[]): string[] {
  const out: string[] = [];
  for (const block of raw) {
    for (const line of block.split("\n")) {
      const q = line
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
        .replace(/^["“'](.*)["”']$/, "$1")
        .replace(/\s+/g, " ")
        .trim();
      if (q && q.length <= MAX_FOLLOWUP_CHARS && !out.includes(q)) out.push(q);
    }
  }
  return out.slice(0, MAX_FOLLOWUPS);
}

/** What the model is told about follow-ups. */
export function followUpInstructions(name: string): string {
  return [
    `After answering, when it would help ${name} go further, end your reply with ${FOLLOWUPS_OPEN} on its own line, then 2 or 3 short follow-up questions ${name} might ask you next (one per line, written as ${name} would ask them, under 12 words each), then ${FOLLOWUPS_CLOSE}.`,
    "Make them specific to this answer, not generic. Skip them for greetings, thanks, quick factual replies, or when the conversation is clearly finished. Put them at the very end, after everything else.",
  ].join(" ");
}

/** The selected answer text a question is about, as the model sees it in front of the question. */
export function withQuote(text: string, quote: string | undefined): string {
  if (!quote) return text;
  const quoted = quote
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return `About this part of your earlier answer:\n${quoted}\n\n${text}`;
}

/** A quote sent by the browser: plain text, trimmed and capped, or nothing. */
export function cleanQuote(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const q = v.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return q ? q.slice(0, MAX_QUOTE_CHARS) : undefined;
}
