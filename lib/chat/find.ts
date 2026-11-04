/**
 * Search your chats: the search box above the chat list. Titles are matched in the browser as you
 * type; words inside messages are found in Postgres (`search_my_chats`), as the signed-in person,
 * so only their own chats ever come back. This file turns a matching message into the short
 * snippet the list shows, and marks the search words in it.
 */

export type ChatHit = { chatId: string; messageId: string; role: "user" | "assistant"; snippet: string };

/** The words to look for and mark, longest first so "boilers" is marked before "boiler". */
export function searchTerms(query: string): string[] {
  const q = query.replace(/\s+/g, " ").trim().toLowerCase();
  if (!q) return [];
  const words = q
    .split(/[\s"']+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}£$€#@]+|[^\p{L}\p{N}%]+$/gu, ""))
    .filter((w) => w.length >= 2 && !STOP.has(w));
  return [...new Set([q, ...words])].sort((a, b) => b.length - a.length);
}

/** Message text as plain words: no code fences, markdown marks or links, on one line. */
export function plainText(text: string): string {
  return text
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * About `max` characters of the message around the first search word, with "…" where it was cut.
 * Search words can match a longer word ("boiler" in "boilers"), and stemmed matches that share no
 * letters fall back to the start of the message.
 */
export function snippet(text: string, query: string, max = 140): string {
  const plain = plainText(text);
  if (plain.length <= max) return plain;
  const lower = plain.toLowerCase();
  let at = -1;
  for (const t of searchTerms(query)) {
    const i = lower.indexOf(stem(t));
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return plain.slice(0, max - 1).trimEnd() + "…";
  let start = Math.max(0, at - Math.floor(max / 3));
  // Start on a word boundary.
  if (start > 0) {
    const space = plain.lastIndexOf(" ", start);
    start = space >= 0 && at - space < max / 2 ? space + 1 : start;
  }
  let end = Math.min(plain.length, start + max);
  if (end < plain.length) {
    const space = plain.lastIndexOf(" ", end);
    if (space > at) end = space;
  }
  return (start > 0 ? "…" : "") + plain.slice(start, end).trim() + (end < plain.length ? "…" : "");
}

/** The snippet split into plain and marked parts, for showing the search words in bold. */
export function marked(text: string, query: string): { text: string; hit: boolean }[] {
  const terms = searchTerms(query).map(stem).filter((t) => t.length >= 2);
  if (!terms.length) return [{ text, hit: false }];
  const re = new RegExp(`(${terms.map(escape).join("|")})`, "giu");
  return text
    .split(re)
    .filter(Boolean)
    .map((part) => ({ text: part, hit: terms.some((t) => t === part.toLowerCase()) }));
}

/** A rough English stem, enough to find where "boilers" or "quoted" sits in the text. */
function stem(word: string): string {
  if (word.includes(" ") || word.length < 5) return word;
  return word.replace(/(ing|ies|ied|es|ed|s)$/u, "") || word;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const STOP = new Set(["the", "and", "or", "of", "to", "in", "on", "a", "an", "is", "it", "for", "my", "me", "what", "did", "say", "about"]);
