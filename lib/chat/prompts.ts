/**
 * Saved prompts: a person's reusable messages. A prompt can have blanks written as {{name}},
 * which are asked for when it's used: "Translate {{text}} into {{language}}".
 */
export type SavedPrompt = { id: string; title: string; body: string; updated_at: string };

export const PROMPT_TITLE_MAX = 80;
export const PROMPT_BODY_MAX = 8000;

const BLANK = /\{\{\s*([^{}]{1,60}?)\s*\}\}/g;

/** The blanks in a prompt, each named once, in the order they first appear. */
export function blanksIn(body: string): string[] {
  const seen: string[] = [];
  for (const m of body.matchAll(BLANK)) {
    const name = m[1].replace(/\s+/g, " ");
    if (!seen.some((s) => s.toLowerCase() === name.toLowerCase())) seen.push(name);
  }
  return seen;
}

/** The prompt with each blank replaced by what was typed for it; unfilled blanks are left as they are. */
export function fillBlanks(body: string, values: Record<string, string>): string {
  const byName = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return body.replace(BLANK, (whole, raw: string) => {
    const v = byName.get(raw.replace(/\s+/g, " ").toLowerCase());
    return v && v.trim() ? v.trim() : whole;
  });
}

/** A title from the text when none was typed: its first line, shortened. */
export function promptTitle(title: string, body: string): string {
  const t = (title.trim() || body.trim().split("\n")[0] || "").replace(/\s+/g, " ");
  return t.length > PROMPT_TITLE_MAX ? `${t.slice(0, PROMPT_TITLE_MAX - 1).trimEnd()}…` : t;
}
