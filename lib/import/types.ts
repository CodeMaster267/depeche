/**
 * Importing chats from other AI apps. Shared by the browser (which reads the export) and the
 * server (which checks every batch again before it reaches the database).
 */
import { MAX_MESSAGE_CHARS } from "@/lib/chat/thread";

export type ImportSource = "chatgpt" | "claude" | "gemini";

export const SOURCE_NAMES: Record<ImportSource, string> = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };

export type ImportedMessage = { role: "user" | "assistant"; text: string; created_at: string; model: string | null };

export type ImportedChat = {
  source: ImportSource;
  /** The chat's id in the other app, so importing the same export twice adds nothing new. */
  key: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: ImportedMessage[];
};

/** Each person's import allowance, in characters of text (matches `import_text_limit()`). */
export const IMPORT_TEXT_LIMIT = 20_000_000;
/** Messages kept from one imported chat. */
export const MAX_IMPORT_MESSAGES = 5_000;
/** Text kept from one imported chat, so any single chat fits in one request to Vercel. */
export const MAX_CHAT_CHARS = 2_500_000;
/** A batch sent to the server: well under Vercel's 4.5 MB request limit. */
export const BATCH_CHARS = 1_000_000;
export const BATCH_CHATS = 40;
/** The server refuses anything bigger than this. */
export const MAX_BODY_CHARS = 4_000_000;

const CUT_NOTE = "\n\n[…the rest of this message was too long to import]";
const CHAT_CUT_NOTE = "[The rest of this chat was too long to import.]";

/** Text as stored: trimmed, no NUL characters (Postgres refuses them), at most one message long. */
export function cleanText(text: string): string {
  const t = text.replace(/\u0000/g, "").trim();
  return t.length > MAX_MESSAGE_CHARS ? t.slice(0, MAX_MESSAGE_CHARS - CUT_NOTE.length) + CUT_NOTE : t;
}

/** A date as ISO text, or null if it isn't one. Accepts seconds since 1970 (ChatGPT) or ISO text. */
export function isoDate(value: unknown): string | null {
  let d: Date | null = null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) d = new Date(value * 1000);
  else if (typeof value === "string" && value) d = new Date(value);
  if (!d || Number.isNaN(d.getTime())) return null;
  if (d.getUTCFullYear() < 2000 || d.getTime() > Date.now() + 86_400_000) return null;
  return d.toISOString();
}

/**
 * Tidies one chat: drops empty messages, merges back-to-back messages from the same side (other
 * apps split a reply around tool use), keeps times in order, and caps its size. Null if nothing
 * is left to import.
 */
export function finishChat(chat: Omit<ImportedChat, "created_at" | "updated_at"> & { created_at: string | null; updated_at: string | null }): ImportedChat | null {
  const merged: ImportedMessage[] = [];
  for (const m of chat.messages) {
    const text = m.text.replace(/\u0000/g, "").trim();
    if (!text) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.text += "\n\n" + text;
      last.model = last.model ?? m.model;
    } else merged.push({ ...m, text });
  }
  if (!merged.length) return null;

  const fallback = chat.created_at ?? merged.find((m) => m.created_at)?.created_at ?? new Date().toISOString();
  let prev = "";
  let total = 0;
  const messages: ImportedMessage[] = [];
  for (const m of merged.slice(0, MAX_IMPORT_MESSAGES)) {
    let at = m.created_at || prev || fallback;
    if (prev && at < prev) at = prev; // the database nudges equal times apart, in this order
    prev = at;
    const text = cleanText(m.text);
    if (total + text.length > MAX_CHAT_CHARS) {
      messages.push({ role: "assistant", text: CHAT_CUT_NOTE, created_at: at, model: null });
      break;
    }
    total += text.length;
    messages.push({ role: m.role, text, created_at: at, model: m.model ? m.model.slice(0, 100) : null });
  }
  const first = messages[0].created_at;
  const last = messages[messages.length - 1].created_at;
  const created = chat.created_at && chat.created_at <= first ? chat.created_at : first;
  const updated = chat.updated_at && chat.updated_at >= last ? chat.updated_at : last;
  return {
    source: chat.source,
    key: chat.key.slice(0, 200),
    title: chat.title.replace(/\s+/g, " ").trim().slice(0, 200) || "Imported chat",
    created_at: created,
    updated_at: updated,
    messages,
  };
}

const chatChars = (c: ImportedChat) => c.messages.reduce((n, m) => n + m.text.length, 0) + 500;

/** Groups chats into requests small enough for Vercel, newest chats first. */
export function batches(chats: ImportedChat[]): ImportedChat[][] {
  const sorted = [...chats].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  const out: ImportedChat[][] = [];
  let cur: ImportedChat[] = [];
  let size = 0;
  for (const c of sorted) {
    const n = chatChars(c);
    if (cur.length && (size + n > BATCH_CHARS || cur.length >= BATCH_CHATS)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(c);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * The server's check of one batch from the browser. Returns the chats exactly as they will be
 * stored, or null if anything is off (the browser built it, so nothing should be).
 */
export function validateBatch(body: unknown): ImportedChat[] | null {
  if (!body || typeof body !== "object" || !Array.isArray((body as { chats?: unknown }).chats)) return null;
  const list = (body as { chats: unknown[] }).chats;
  if (!list.length || list.length > BATCH_CHATS) return null;
  const out: ImportedChat[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") return null;
    const c = raw as Record<string, unknown>;
    if (c.source !== "chatgpt" && c.source !== "claude" && c.source !== "gemini") return null;
    if (typeof c.key !== "string" || !c.key || c.key.length > 200) return null;
    if (typeof c.title !== "string" || c.title.length > 200) return null;
    if (!Array.isArray(c.messages) || !c.messages.length || c.messages.length > MAX_IMPORT_MESSAGES + 1) return null;
    const created = isoDate(c.created_at);
    const updated = isoDate(c.updated_at);
    if (!created || !updated) return null;
    const messages: ImportedMessage[] = [];
    let total = 0;
    for (const rm of c.messages) {
      if (!rm || typeof rm !== "object") return null;
      const m = rm as Record<string, unknown>;
      if (m.role !== "user" && m.role !== "assistant") return null;
      if (typeof m.text !== "string" || !m.text.trim() || m.text.length > MAX_MESSAGE_CHARS) return null;
      if (m.model !== null && m.model !== undefined && (typeof m.model !== "string" || m.model.length > 100)) return null;
      const at = isoDate(m.created_at);
      if (!at) return null;
      total += m.text.length;
      messages.push({ role: m.role, text: m.text.replace(/\u0000/g, ""), created_at: at, model: (m.model as string | null | undefined) || null });
    }
    if (total > MAX_CHAT_CHARS + 1000) return null;
    out.push({ source: c.source, key: c.key, title: c.title.trim() || "Imported chat", created_at: created, updated_at: updated, messages });
  }
  return out;
}
